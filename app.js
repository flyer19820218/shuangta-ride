/* 雙塔騎行助手 v2 — 畫面、定位、補給、海拔、改道段 */
(function () {
  'use strict';
  const C = window.Core;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 空間滿或無痕模式：忽略 */ } },
    keys() { try { return Object.keys(localStorage).filter(k => k.indexOf('sh2.') === 0); } catch (e) { return []; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { } },
  };

  // ---------- 狀態 ----------
  let R = null;                 // route.json
  let baseTrack = null;         // 原始參考軌跡
  let track = null, cum = null, asc = null;   // 目前使用中的軌跡
  let pois = [];                // 目前軌跡上的補給點（已算好 km / on）
  let extraPois = LS.get('sh2.extra', []);    // Overpass 補充的點
  const state = Object.assign({ danjiang: true, tainan: true, speed: 25 }, LS.get('sh2.state', {}));
  const detourInfo = {};        // id -> {status, msg, km, refKm, maxSnap, seg}
  let me = null;                // {lat, lon, acc, snap}
  let hint = null;
  let gpsId = null, follow = true, wakeLock = null, wakeWanted = false;
  let eleMode = 'all';
  let lastDoneIdx = -999;
  const saveState = () => LS.set('sh2.state', state);

  // ---------- 地圖 ----------
  const map = L.map('map', { zoomControl: false }).setView([23.8, 120.9], 7);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  let routeLine = null, doneLine = null, meMarker = null, accCircle = null;
  const poiLayer = L.layerGroup().addTo(map);
  const candLayers = {};
  map.on('dragstart', () => { if (follow) { follow = false; $('btnFollow').textContent = '跟隨：關'; } });

  // ---------- 小工具 ----------
  const hud = t => { $('hud').innerHTML = t; };
  const clock = ms => new Date(ms).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  const gmaps = (la, lo) => 'https://www.google.com/maps/dir/?api=1&destination=' + la + ',' + lo + '&travelmode=bicycling';
  const total = () => cum[cum.length - 1];

  function fetchTimeout(url, ms, opt) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    return fetch(url, Object.assign({ signal: ac.signal }, opt || {})).finally(() => clearTimeout(t));
  }

  function badge(p) {
    if (p.t === 'store') {
      if (p.b === '7-11') return { c: 'b711', x: '7' };
      if (p.b === '全家') return { c: 'bfm', x: '全' };
      if (p.b === '萊爾富') return { c: 'bhl', x: '萊' };
      if (p.b === 'OK') return { c: 'bok', x: 'O' };
      return { c: 'bother', x: '商' };
    }
    return ({ rest: { c: 'brest', x: '休' }, check: { c: 'bchk', x: '檢' }, water: { c: 'bwater', x: '水' },
      wc: { c: 'bwc', x: '廁' }, food: { c: 'bfood', x: '食' } })[p.t] || { c: 'bother', x: '?' };
  }

  function kindsSet() {
    const s = new Set();
    document.querySelectorAll('#kinds input').forEach(i => { if (i.checked) s.add(i.dataset.k); });
    if (!s.size) s.add('store');
    return s;
  }

  // ---------- 載入 ----------
  async function boot() {
    try {
      const res = await fetch('route.json', { cache: 'no-cache' });
      R = await res.json();
    } catch (e) {
      hud('❌ 載入 route.json 失敗：' + esc(e.message));
      return;
    }
    baseTrack = R.track;
    $('speed').value = state.speed;
    $('srcInfo').innerHTML = esc(R.meta.name) + '<br>來源：' + esc(R.meta.source) + '<br>全程 ' + R.meta.km + ' km、爬升約 ' + R.meta.ascent + ' m（依海拔資料估算）。<br>' +
      '補給點資料為參考 GPX 內的 ' + R.pois.length + ' 個點；店家營業狀況請以現場為準。';
    loadCachedDetours();
    for (const d of R.detours) if (d.seg && d.seg.length > 1) detourInfo[d.id] = presetInfo(d);   // 預先驗證的路線先就位
    bindUi();
    rebuild(true);
    for (const d of R.detours) if (state[d.id] && !(d.seg && d.seg.length > 1)) ensureDetour(d.id);   // 沒有預設路線的才連網算
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
    const q = new URLSearchParams(location.search);
    if (q.has('sim')) { $('simOn').checked = true; $('simKm').value = q.get('sim'); applySim(); }
  }

  // ---------- 改道段 ----------
  function loadCachedDetours() {
    for (const d of R.detours) {
      const c = LS.get('sh2.detour.' + d.id, null);
      if (!c) continue;
      const maxAge = c.status === 'ok' ? 14 * 864e5 : 12 * 36e5;
      if (Date.now() - c.at > maxAge) continue;
      detourInfo[d.id] = c;
    }
  }

  /** route.json 內附的「預先驗證路線」：不用連網，直接當作已算好的結果 */
  function presetInfo(d) {
    const len = d.seg.reduce((s, p, i) => i ? s + C.hv(d.seg[i - 1], p) : 0, 0) / 1000;
    return { status: 'ok', seg: d.seg, km: len, refKm: d.b.km - d.a.km, maxSnap: 0, preset: true, verified: d.verified || '' };
  }

  async function ensureDetour(id) {
    const d = R.detours.find(x => x.id === id);
    if (d.seg && d.seg.length > 1) { detourInfo[id] = presetInfo(d); renderDetours(); rebuild(false); return; }
    const cur = detourInfo[id];
    if (cur && (cur.status === 'ok' || cur.status === 'rejected' || cur.status === 'loading')) { renderDetours(); rebuild(false); return; }
    detourInfo[id] = { status: 'loading' };
    renderDetours();
    try {
      const coords = [[d.a.lon, d.a.lat]].concat(d.via.map(v => [v[1], v[0]]), [[d.b.lon, d.b.lat]]).map(c => c.join(',')).join(';');
      const url = 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/' + coords + '?overview=full&geometries=geojson';
      const j = await (await fetchTimeout(url, 30000)).json();
      if (j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error(j.code || '路由沒有結果');
      const rt = j.routes[0];
      const km = rt.distance / 1000, refKm = d.b.km - d.a.km;
      const maxSnap = Math.max.apply(null, (j.waypoints || []).map(w => w.distance || 0).concat([0]));
      const seg = rt.geometry.coordinates.map(c => [c[1], c[0]]);
      const info = { at: Date.now(), km, refKm, maxSnap };
      if (d.mode === 'auto' && km > refKm - 2) {
        info.status = 'rejected';
        info.msg = '路由算出 ' + km.toFixed(1) + ' km，沒有比原路線（' + refKm.toFixed(1) + ' km）短，應該是地圖資料還沒收錄新橋的自行車道，先維持原路線。';
      } else {
        info.status = 'ok';
        info.seg = seg;
      }
      detourInfo[id] = info;
      LS.set('sh2.detour.' + id, info);
    } catch (e) {
      detourInfo[id] = { status: 'error', msg: (e.name === 'AbortError' ? '逾時' : e.message) + '（目前沒網路或路由服務忙碌）' };
    }
    renderDetours();
    rebuild(false);
  }

  function renderDetours() {
    const box = $('detours');
    if (!R) return;
    box.innerHTML = R.detours.map(d => {
      const i = detourInfo[d.id] || {};
      let st = '<span class="mut">尚未計算</span>', cls = '';
      if (i.status === 'loading') st = '計算中…';
      else if (i.status === 'ok') {
        const diff = i.km - i.refKm;
        st = (i.preset ? '✅ 已驗證（' + esc(i.verified) + '）：' : '✅ ') + '新路線 <b>' + i.km.toFixed(1) + ' km</b>（原路線 ' + i.refKm.toFixed(1) + ' km，' + (diff <= 0 ? '省 ' + (-diff).toFixed(1) : '多 ' + diff.toFixed(1)) + ' km）';
        if (i.maxSnap > 300) st += '<br>⚠ 有路線點離道路 ' + Math.round(i.maxSnap) + ' m，請在地圖上檢查';
        cls = 'good';
      } else if (i.status === 'rejected') { st = '⚠ ' + esc(i.msg); cls = 'warn'; }
      else if (i.status === 'error') { st = '❌ ' + esc(i.msg); cls = 'bad'; }
      const on = !!state[d.id];
      return '<div class="card ' + cls + '"><label class="t"><input type="checkbox" data-d="' + d.id + '"' + (on ? ' checked' : '') + '> <b>' + esc(d.name) + '</b></label>' +
        '<div class="mut" style="font-size:13px">' + esc(d.note) + '</div><div style="margin-top:4px">' + st + '</div>' +
        (i.status === 'error' || i.status === 'rejected' ? '<div class="row"><button class="b alt" data-retry="' + d.id + '">重新計算</button></div>' : '') + '</div>';
    }).join('');
    box.querySelectorAll('input[data-d]').forEach(el => el.onchange = () => {
      state[el.dataset.d] = el.checked; saveState();
      if (el.checked) ensureDetour(el.dataset.d); else rebuild(false);
    });
    box.querySelectorAll('button[data-retry]').forEach(el => el.onclick = () => {
      const id = el.dataset.retry; LS.del('sh2.detour.' + id); delete detourInfo[id]; ensureDetour(id);
    });
  }

  // ---------- 重建路線 ----------
  function rebuild(fit) {
    let t = baseTrack;
    const act = R.detours.filter(d => state[d.id] && detourInfo[d.id] && detourInfo[d.id].status === 'ok')
      .sort((x, y) => y.a.idx - x.a.idx);
    for (const d of act) t = C.applyDetour(t, d.a, d.b, detourInfo[d.id].seg);
    track = t; cum = C.buildCum(track); asc = C.ascentStats(track, 2);
    hint = null; lastDoneIdx = -999;
    $('simKm').max = Math.floor(total());
    drawRoute(fit);
    rebuildPois();
    drawCandidates();
    renderDetours();
    if (me) onPosition(me.lat, me.lon, me.acc); else summary();
    drawEle();
  }

  function summary() {
    hud('全程 <b>' + C.fmtKm(total()) + ' km</b> ・ 爬升約 ' + Math.round(asc.up) + ' m ・ 補給點 ' + pois.filter(p => p.on).length + ' 個');
    $('sLeft').textContent = C.fmtKm(total());
  }

  function drawRoute(fit) {
    if (routeLine) routeLine.remove();
    if (doneLine) doneLine.remove();
    const ll = track.map(p => [p[0], p[1]]);
    routeLine = L.polyline(ll, { color: '#d32f2f', weight: 4, opacity: 0.85 }).addTo(map);
    doneLine = L.polyline([], { color: '#8e8e93', weight: 5, opacity: 0.9 }).addTo(map);
    if (fit) map.fitBounds(routeLine.getBounds(), { padding: [20, 20] });
  }

  function drawCandidates() {
    Object.keys(candLayers).forEach(k => { candLayers[k].remove(); delete candLayers[k]; });
    for (const d of R.detours) {
      const i = detourInfo[d.id];
      if (i && i.status === 'ok' && !state[d.id]) {
        candLayers[d.id] = L.polyline(i.seg, { color: '#7b1fa2', weight: 4, dashArray: '8 8', opacity: 0.9 }).addTo(map).bindTooltip(d.name);
      }
    }
  }

  function rebuildPois() {
    pois = C.attachPois(track, cum, C.mergePois(R.pois, extraPois), 600);
    poiLayer.clearLayers();
    for (const p of pois) {
      const b = badge(p);
      const m = L.marker([p.la, p.lo], {
        icon: L.divIcon({ className: '', iconSize: [22, 22], html: '<div class="mk ' + b.c + (p.on ? '' : ' faint') + '">' + b.x + '</div>' }),
      }).addTo(poiLayer);
      m.bindPopup(() => {
        let h = '<b>' + esc(p.n) + '</b><br>' + (p.on ? '路線 km ' + p.km.toFixed(1) : '不在目前路線上（離路線約 ' + (p.off / 1000).toFixed(1) + ' km）');
        if (me && p.on) h += '<br>距你 ' + C.fmtKm(p.km - me.snap.km) + ' km（沿路線）';
        if (p.extra) h += '<br><span class="mut">資料來源：OpenStreetMap</span>';
        return h + '<br><a href="' + gmaps(p.la, p.lo) + '" target="_blank" rel="noopener">用 Google 地圖導航</a>';
      });
    }
    renderSup();
  }

  // ---------- 定位 ----------
  function onPosition(lat, lon, acc) {
    const s = C.snapToTrack(track, cum, [lat, lon], hint, 400);
    hint = s.idx;
    me = { lat, lon, acc, snap: s };
    const ll = [lat, lon];
    if (!meMarker) {
      meMarker = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#1976d2', fillOpacity: 1 }).addTo(map);
      accCircle = L.circle(ll, { radius: acc, color: '#1976d2', weight: 1, fillOpacity: 0.1 }).addTo(map);
    } else {
      meMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(acc);
    }
    if (Math.abs(s.idx - lastDoneIdx) >= 3) {
      doneLine.setLatLngs(track.slice(0, s.idx + 1).map(p => [p[0], p[1]]));
      lastDoneIdx = s.idx;
    }
    if (follow) map.setView(ll, Math.max(map.getZoom(), 14), { animate: true });
    renderNav();
    renderSup();
    if ($('p-ele').classList.contains('on')) drawEle();
  }

  function renderNav() {
    if (!me) return;
    const s = me.snap, done = s.km, left = total() - done;
    $('sDone').textContent = C.fmtKm(done);
    $('sLeft').textContent = C.fmtKm(left);
    $('sOff').textContent = Math.round(s.off);
    $('sEle').textContent = Math.round(s.ele);

    const up = C.upcoming(pois, done, kindsSet(), 3);
    const sp = state.speed || 25;
    let html, cls = 'card';
    if (up.length) {
      const n = up[0], b = badge(n);
      const mins = n.dist / sp * 60;
      html = '<div class="poi"><div class="badge ' + b.c + '">' + b.x + '</div><div class="nm"><b>' + esc(n.n) + '</b><small>約 ' + C.fmtDur(mins) +
        '後，' + clock(Date.now() + mins * 6e4) + ' 到</small></div><div class="d">' + C.fmtKm(n.dist) + ' km</div></div>';
      if (n.dist > 25) { cls += ' warn'; html += '<div>⚠ 下一個登錄的補給在 ' + C.fmtKm(n.dist) + ' km 外，水和補給要帶夠。到「補給」分頁按「更新前方 40 km」可補查便利商店。</div>'; }
      if (up[1]) html += '<small class="mut">再下一個：' + esc(up[1].n) + '（' + C.fmtKm(up[1].dist) + ' km）</small>';
    } else {
      cls += ' warn';
      html = '前方沒有登錄的補給點。到「補給」分頁按「更新前方 40 km」查一下。';
    }
    if (s.off > 200) { cls = 'card bad'; html = '⚠ 你離路線 <b>' + Math.round(s.off) + ' m</b>，補給距離以路線上最近的位置估算。<br>' + html; }
    $('nextCard').className = cls; $('nextCard').innerHTML = html;

    const mins = left / sp * 60, upLeft = Math.max(0, asc.up - asc.cumUp[s.idx]);
    $('etaCard').innerHTML = '剩餘爬升約 <b>' + Math.round(upLeft) + ' m</b> ・ 以 ' + sp + ' km/h 估，還要 <b>' + C.fmtDur(mins) + '</b>，預計 <b>' + clock(Date.now() + mins * 6e4) + '</b> 抵達鵝鑾鼻。';
    hud('已騎 <b>' + C.fmtKm(done) + '</b> ・ 剩 <b>' + C.fmtKm(left) + '</b> km' + (up[0] ? ' ・ 下一站 ' + esc(up[0].b || up[0].n) + ' ' + C.fmtKm(up[0].dist) + ' km' : '') +
      (s.off > 200 ? ' ・ <span style="color:var(--bad)">偏離 ' + Math.round(s.off) + ' m</span>' : ''));
    renderBack();
  }

  // ---------- 回到路線（迷路用，不用 Google） ----------
  let guideLine = null, backLine = null, backInfo = null;

  function clearBack() {
    if (guideLine) { guideLine.remove(); guideLine = null; }
    if (backLine) { backLine.remove(); backLine = null; }
    backInfo = null; $('backSteps').innerHTML = '';
  }

  function backTarget() {   // 路線上、你前進方向前方約 150 m 的點
    return track[C.rejoinTarget(cum, me.snap.idx, 0.15)];
  }

  function renderBack() {
    const card = $('backCard');
    if (!me || me.snap.off <= 80) { card.hidden = true; if (guideLine || backLine) clearBack(); return; }
    const t = backTarget(), from = [me.lat, me.lon];
    const brg = C.bearing(from, [t[0], t[1]]), d = C.hv(from, [t[0], t[1]]);
    card.hidden = false;
    $('backTxt').innerHTML = '<span class="arrow" style="transform:rotate(' + Math.round(brg) + 'deg)">↑</span> 你離開路線了。往 <b>' +
      C.compass8(brg) + '</b> 約 <b>' + C.fmtDist(d) + '</b> 可回到路線（地圖上的橘色虛線）。';
    $('backG').href = gmaps(t[0], t[1]);
    if (!guideLine) guideLine = L.polyline([], { color: '#ef6c00', weight: 4, dashArray: '6 8' }).addTo(map);
    guideLine.setLatLngs([from, [t[0], t[1]]]);
    if (backInfo && C.hv(from, backInfo.from) > 150) {
      $('backSteps').innerHTML = '<span class="mut">你已經移動了一段，上面的轉彎提示過時，請重新規劃。</span>';
      backInfo = null;
    }
  }

  async function planBack() {
    if (!me || me.snap.off <= 80) return;
    const t = backTarget(), from = [me.lat, me.lon];
    $('btnBack').disabled = true; $('backSteps').textContent = '規劃中…';
    try {
      const u = 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/' + me.lon + ',' + me.lat + ';' + t[1] + ',' + t[0] +
        '?overview=full&geometries=geojson&steps=true';
      const j = await (await fetchTimeout(u, 20000)).json();
      if (j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error(j.code || '沒有結果');
      const rt = j.routes[0];
      if (backLine) backLine.remove();
      backLine = L.polyline(rt.geometry.coordinates.map(c => [c[1], c[0]]), { color: '#ef6c00', weight: 5, opacity: 0.95 }).addTo(map);
      const steps = [].concat.apply([], rt.legs.map(l => l.steps));
      backInfo = { from };
      $('backSteps').innerHTML = '<b>實際騎法：' + C.fmtDist(rt.distance) + '，約 ' + C.fmtDur(rt.duration / 60) + '</b><ol>' +
        steps.slice(0, 12).map(s => '<li>' + esc(C.stepText(s)) + '</li>').join('') + '</ol>' +
        (steps.length > 12 ? '<div class="mut">…還有 ' + (steps.length - 12) + ' 步，騎近時再按一次重新規劃。</div>' : '');
    } catch (e) {
      $('backSteps').textContent = '規劃失敗：' + (e.name === 'AbortError' ? '逾時' : e.message) + '。沒訊號時，先照橘色虛線的方向騎，接回紅線即可。';
    }
    $('btnBack').disabled = false;
  }

  function gpsMsg(t) { $('gpsMsg').textContent = t || ''; }

  function startGps() {
    if ($('simOn').checked) { gpsMsg('目前使用模擬位置，請先到「路線」分頁關掉。'); return; }
    if (!navigator.geolocation) { gpsMsg('這個瀏覽器不支援定位。'); return; }
    if (gpsId != null) return;
    gpsMsg('定位中…（第一次請在跳出的視窗按「允許」）');
    gpsId = navigator.geolocation.watchPosition(
      p => { gpsMsg('GPS 誤差約 ' + Math.round(p.coords.accuracy) + ' m'); onPosition(p.coords.latitude, p.coords.longitude, p.coords.accuracy); },
      e => {
        gpsMsg(e.code === 1 ? '定位被拒絕：請到手機的瀏覽器／系統設定允許定位，網址要是 https。' : '定位失敗：' + e.message);
        if (e.code === 1) stopGps();
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
    $('btnGps').textContent = '停止定位'; $('btnGps').classList.add('on');
  }
  function stopGps() {
    if (gpsId != null) navigator.geolocation.clearWatch(gpsId);
    gpsId = null; $('btnGps').textContent = '開始定位'; $('btnGps').classList.remove('on');
  }

  async function setWake(on) {
    wakeWanted = on;
    try {
      if (on) {
        if (!('wakeLock' in navigator)) { gpsMsg('這個瀏覽器不支援保持亮屏。'); wakeWanted = false; return; }
        wakeLock = await navigator.wakeLock.request('screen');
      } else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { gpsMsg('保持亮屏失敗：' + e.message); wakeWanted = false; }
    $('btnWake').textContent = '保持亮屏：' + (wakeWanted ? '開' : '關');
    $('btnWake').classList.toggle('on', wakeWanted);
  }
  document.addEventListener('visibilitychange', () => { if (wakeWanted && document.visibilityState === 'visible') setWake(true); });

  // ---------- 模擬位置（在家測試用） ----------
  function applySim() {
    const on = $('simOn').checked, km = +$('simKm').value;
    $('simLbl').textContent = on ? '模擬在路線 km ' + km : '';
    if (!on) return;
    stopGps();
    let i = 0;
    while (i < cum.length - 1 && cum[i] < km) i++;
    const off = +$('simOff').value;
    $('simOffLbl').textContent = off;
    onPosition(track[i][0] + off / 111195, track[i][1], 5);
  }

  // ---------- 補給 ----------
  function renderSup() {
    if (!pois.length) return;
    const from = me ? me.snap.km : 0;
    const up = C.upcoming(pois, from, kindsSet(), 15);
    $('supList').innerHTML = (me ? '' : '<div class="mut" style="margin-bottom:4px">尚未定位，以下從起點開始列。</div>') +
      (up.length ? up.map(p => {
        const b = badge(p);
        return '<div class="poi"><div class="badge ' + b.c + '">' + b.x + '</div><div class="nm"><b>' + esc(p.n) + '</b><small>路線 km ' + p.km.toFixed(1) + (p.extra ? ' ・ OSM' : '') +
          ' ・ <a href="' + gmaps(p.la, p.lo) + '" target="_blank" rel="noopener">導航</a></small></div><div class="d">' + C.fmtKm(p.dist) + ' km</div></div>';
      }).join('') : '<div class="mut">前方沒有符合的點。</div>');
  }

  async function fetchAhead() {
    const from = me ? me.snap.km : 0, to = Math.min(total(), from + 40);
    const pts = C.samplePolyline(track, cum, from, to, 1);
    if (!pts.length) { $('supMsg').textContent = '前方已沒有路線。'; return; }
    const poly = pts.map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(',');
    const q = '[out:json][timeout:40];(nwr["shop"="convenience"](around:300,' + poly + ');nwr["amenity"="drinking_water"](around:300,' + poly +
      ');nwr["amenity"="toilets"](around:300,' + poly + '););out center tags;';
    $('btnAhead').disabled = true; $('supMsg').textContent = '查詢中…';
    try {
      const res = await fetchTimeout('https://overpass-api.de/api/interpreter', 45000, { method: 'POST', body: 'data=' + encodeURIComponent(q) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const ex = C.parseOverpass((await res.json()).elements || []);
      const before = extraPois.length;
      extraPois = C.mergePois(extraPois, ex).slice(-800);
      LS.set('sh2.extra', extraPois);
      rebuildPois();
      $('supMsg').textContent = '查到 ' + ex.length + ' 個點（新增 ' + (extraPois.length - before) + ' 個），範圍 km ' + from.toFixed(0) + '～' + to.toFixed(0) + '。已存在手機，之後沒訊號也看得到。';
    } catch (e) {
      $('supMsg').textContent = '查詢失敗：' + (e.name === 'AbortError' ? '逾時' : e.message) + '。Overpass 偶爾忙碌，稍後再試。';
    }
    $('btnAhead').disabled = false;
  }

  async function fetchNear() {
    if (!me) { $('supMsg').textContent = '請先在「導航」分頁開始定位（或在「路線」分頁用模擬位置）。'; return; }
    $('btnNear').disabled = true; $('supMsg').textContent = '查詢中…';
    try {
      const q = '[out:json][timeout:25];nwr["shop"="convenience"](around:3000,' + me.lat + ',' + me.lon + ');out center tags;';
      const res = await fetchTimeout('https://overpass-api.de/api/interpreter', 30000, { method: 'POST', body: 'data=' + encodeURIComponent(q) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const list = C.parseOverpass((await res.json()).elements || [])
        .map(p => Object.assign(p, { d: C.hv([me.lat, me.lon], [p.la, p.lo]) })).sort((a, b) => a.d - b.d).slice(0, 6);
      $('supMsg').innerHTML = list.length ? '<b>離你最近（直線距離）</b>' + list.map(p => {
        const b = badge(p);
        return '<div class="poi"><div class="badge ' + b.c + '">' + b.x + '</div><div class="nm"><b>' + esc(p.n) + '</b><small><a href="' + gmaps(p.la, p.lo) + '" target="_blank" rel="noopener">導航</a></small></div><div class="d">' +
          (p.d >= 1000 ? (p.d / 1000).toFixed(1) + ' km' : Math.round(p.d) + ' m') + '</div></div>';
      }).join('') : '3 km 內沒有查到便利商店。';
    } catch (e) {
      $('supMsg').textContent = '查詢失敗：' + (e.name === 'AbortError' ? '逾時' : e.message);
    }
    $('btnNear').disabled = false;
  }

  // ---------- 海拔圖 ----------
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888'; }

  function eleRange() {
    const done = me ? me.snap.km : 0;
    return eleMode === 'ahead' ? [done, Math.min(total(), done + 30)] : [0, total()];
  }

  function drawEle() {
    if (!track) return;
    const cv = $('cv'), w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const [k0, k1] = eleRange();
    const idx = [];
    for (let i = 0; i < track.length; i++) if (cum[i] >= k0 && cum[i] <= k1) idx.push(i);
    if (idx.length < 2) return;
    const step = Math.max(1, Math.floor(idx.length / 500));
    const pts = idx.filter((_, j) => j % step === 0).map(i => [cum[i], track[i][2]]);
    let emax = 20; pts.forEach(p => { if (p[1] > emax) emax = p[1]; });
    emax = Math.ceil(emax / 10) * 10;
    const L0 = 30, B0 = h - 18, T0 = 8, W0 = w - L0 - 8;
    const X = k => L0 + (k - k0) / ((k1 - k0) || 1) * W0, Y = e => B0 - e / emax * (B0 - T0);
    const fg = cssVar('--fg'), mut = cssVar('--mut'), acc = cssVar('--acc');
    g.font = '10px sans-serif'; g.fillStyle = mut; g.strokeStyle = mut; g.lineWidth = 0.5;
    [0, emax / 2, emax].forEach(e => { g.beginPath(); g.moveTo(L0, Y(e)); g.lineTo(w - 8, Y(e)); g.globalAlpha = 0.3; g.stroke(); g.globalAlpha = 1; g.fillText(Math.round(e) + '', 2, Y(e) + 3); });
    for (let j = 0; j <= 4; j++) {
      const k = k0 + (k1 - k0) * j / 4;
      g.textAlign = j === 0 ? 'left' : j === 4 ? 'right' : 'center';
      g.fillText(k.toFixed(0), X(k), h - 4);
    }
    g.textAlign = 'left';
    g.beginPath(); g.moveTo(X(pts[0][0]), B0);
    pts.forEach(p => g.lineTo(X(p[0]), Y(p[1])));
    g.lineTo(X(pts[pts.length - 1][0]), B0); g.closePath();
    g.fillStyle = acc; g.globalAlpha = 0.25; g.fill(); g.globalAlpha = 1;
    g.beginPath(); pts.forEach((p, j) => j ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])));
    g.strokeStyle = acc; g.lineWidth = 1.5; g.stroke();
    pois.filter(p => p.on && (p.t === 'store' || p.t === 'rest') && p.km >= k0 && p.km <= k1).forEach(p => {
      g.fillStyle = p.t === 'rest' ? '#6d4cc2' : '#e8420c'; g.fillRect(X(p.km) - 1, B0 - 7, 2, 7);
    });
    if (me && me.snap.km >= k0 && me.snap.km <= k1) {
      g.strokeStyle = '#d32f2f'; g.lineWidth = 2; g.beginPath(); g.moveTo(X(me.snap.km), T0); g.lineTo(X(me.snap.km), B0); g.stroke();
    }
    cv._m = { k0, k1, L0, W0 };
    let info = '總爬升約 ' + Math.round(asc.up) + ' m ・ 最高 ' + Math.max.apply(null, track.map(p => p[2])) + ' m。';
    if (me) {
      const j = Math.min(track.length - 1, me.snap.idx + 1);
      let jj = j; while (jj < track.length - 1 && cum[jj] < me.snap.km + 10) jj++;
      info += '<br>前方 10 km 爬升約 ' + Math.round(asc.cumUp[jj] - asc.cumUp[me.snap.idx]) + ' m。';
    }
    info += '<br><small>橘＝便利商店、紫＝休息站、紅線＝你的位置。點圖可看某處海拔。</small>';
    $('eleInfo').innerHTML = info; $('eleInfo')._base = info;
  }

  function eleTap(ev) {
    const cv = $('cv'), m = cv._m; if (!m) return;
    const r = cv.getBoundingClientRect(), x = (ev.clientX - r.left);
    const km = m.k0 + Math.max(0, Math.min(1, (x - m.L0) / m.W0)) * (m.k1 - m.k0);
    let i = 0; while (i < cum.length - 1 && cum[i] < km) i++;
    $('eleInfo').innerHTML = '<b>km ' + km.toFixed(1) + '</b>：海拔 ' + track[i][2] + ' m' + (me ? '，距你 ' + C.fmtKm(km - me.snap.km) + ' km' : '') + '<br>' + ($('eleInfo')._base || '');
  }

  // ---------- UI 綁定 ----------
  function bindUi() {
    $('tabs').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
      document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'p-' + b.dataset.p));
      if (b.dataset.p === 'ele') drawEle();
      if (b.dataset.p === 'sup') renderSup();
    });
    $('btnGps').onclick = () => gpsId == null ? startGps() : stopGps();
    $('btnBack').onclick = planBack;
    $('btnWake').onclick = () => setWake(!wakeWanted);
    $('btnFollow').onclick = () => { follow = !follow; $('btnFollow').textContent = '跟隨：' + (follow ? '開' : '關'); if (follow && me) map.setView([me.lat, me.lon], Math.max(map.getZoom(), 14)); };
    $('fab').onclick = () => { follow = true; $('btnFollow').textContent = '跟隨：開'; if (me) map.setView([me.lat, me.lon], Math.max(map.getZoom(), 14)); else startGps(); };
    $('kinds').addEventListener('change', () => { renderSup(); renderNav(); });
    $('btnAhead').onclick = fetchAhead;
    $('btnNear').onclick = fetchNear;
    $('eleAll').onclick = () => { eleMode = 'all'; $('eleAll').className = 'b'; $('eleAhead').className = 'b alt'; drawEle(); };
    $('eleAhead').onclick = () => { eleMode = 'ahead'; $('eleAll').className = 'b alt'; $('eleAhead').className = 'b'; drawEle(); };
    $('cv').addEventListener('pointerdown', eleTap);
    $('speed').onchange = () => { const v = +$('speed').value; if (v >= 10 && v <= 45) { state.speed = v; saveState(); renderNav(); } };
    $('simOn').onchange = () => { applySim(); if (!$('simOn').checked) $('simLbl').textContent = ''; };
    $('simKm').oninput = applySim;
    $('simOff').oninput = applySim;
    $('btnClear').onclick = async () => {
      LS.keys().forEach(LS.del);
      try { (await caches.keys()).forEach(k => caches.delete(k)); } catch (e) { }
      location.reload();
    };
    window.addEventListener('resize', () => { if ($('p-ele').classList.contains('on')) drawEle(); });
  }

  boot();
})();
