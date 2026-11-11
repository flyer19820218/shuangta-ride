/* 雙塔騎行助手 — 純計算核心（不碰 DOM，可在 node 測試） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const R = 6371000;
  const rad = x => x * Math.PI / 180;

  /** 兩點直線距離（公尺）。a、b = [lat, lon, ...] */
  function hv(a, b) {
    const dl = rad(b[0] - a[0]), dn = rad(b[1] - a[1]);
    const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dn / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** 累計里程（km），cum[i] = 起點到第 i 點 */
  function buildCum(track) {
    const cum = [0];
    for (let i = 1; i < track.length; i++) cum.push(cum[i - 1] + hv(track[i - 1], track[i]) / 1000);
    return cum;
  }

  /** 累計爬升（遲滯法，thr 公尺以內的起伏不算）。回傳 {up, down, cumUp[]} */
  function ascentStats(track, thr) {
    thr = thr == null ? 2 : thr;
    let up = 0, down = 0, ref = track[0][2] || 0;
    const cumUp = [0];
    for (let i = 1; i < track.length; i++) {
      const e = track[i][2] || 0;
      if (e - ref >= thr) { up += e - ref; ref = e; }
      else if (ref - e >= thr) { down += ref - e; ref = e; }
      cumUp.push(up);
    }
    return { up, down, cumUp };
  }

  /** 點 p 投影到線段 a→b。回傳 {t(0~1), d(公尺)} */
  function projectOnSegment(p, a, b) {
    const k = Math.cos(rad(p[0]));
    const ax = (a[1] - p[1]) * k, ay = a[0] - p[0];
    const bx = (b[1] - p[1]) * k, by = b[0] - p[0];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    return { t, d: Math.sqrt(px * px + py * py) * 111195 };
  }

  function nearestVertex(track, p, lo, hi) {
    const k = Math.cos(rad(p[0]));
    let best = Infinity, bi = lo;
    for (let i = lo; i <= hi; i++) {
      const dx = (track[i][1] - p[1]) * k, dy = track[i][0] - p[0];
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; bi = i; }
    }
    return bi;
  }

  /**
   * 把 GPS 位置吸附到軌跡上。
   * hint = 上次的索引（用來只搜附近，避免來回路段跳掉）；偏離太遠會自動改全域搜尋。
   * 回傳 {idx, km, off(公尺), ele}
   */
  function snapToTrack(track, cum, p, hint, win) {
    win = win || 400;
    const n = track.length;
    let lo = 0, hi = n - 1;
    if (hint != null) { lo = Math.max(0, hint - win); hi = Math.min(n - 1, hint + win); }
    let i = nearestVertex(track, p, lo, hi);
    let res = refine(track, cum, p, i);
    if (hint != null && res.off > 500) {           // 窗內找不到，可能跳段/走遠，全域重搜
      i = nearestVertex(track, p, 0, n - 1);
      res = refine(track, cum, p, i);
    }
    return res;
  }

  function refine(track, cum, p, i) {
    const n = track.length;
    let best = { idx: i, km: cum[i], off: hv(p, track[i]), ele: track[i][2] };
    for (const j of [i - 1, i]) {
      if (j < 0 || j >= n - 1) continue;
      const pr = projectOnSegment(p, track[j], track[j + 1]);
      if (pr.d <= best.off + 1e-6) {
        best = {
          idx: pr.t > 0.5 ? j + 1 : j,
          km: cum[j] + pr.t * (cum[j + 1] - cum[j]),
          off: pr.d,
          ele: track[j][2] + pr.t * (track[j + 1][2] - track[j][2]),
        };
      }
    }
    return best;
  }

  /**
   * 套用改道段：把 track 的 a.idx..b.idx 換成 seg（[[lat,lon],...]）。
   * 海拔用兩端錨點線性內插。多個改道段要由 idx 大的先套。
   */
  function applyDetour(track, a, b, seg) {
    const ea = track[a.idx][2] || 0, eb = track[b.idx][2] || 0;
    const d = [0];
    for (let i = 1; i < seg.length; i++) d.push(d[i - 1] + hv(seg[i - 1], seg[i]));
    const tot = d[d.length - 1] || 1;
    const mid = seg.map((s, i) => [s[0], s[1], Math.round(ea + (eb - ea) * d[i] / tot)]);
    return track.slice(0, a.idx).concat(mid, track.slice(b.idx + 1));
  }

  /** 重新計算每個補給點在目前軌跡上的里程與偏離；偏離 > maxOff 公尺視為「不在路線上」 */
  function attachPois(track, cum, pois, maxOff) {
    maxOff = maxOff || 600;
    return pois.map(p => {
      const r = snapToTrack(track, cum, [p.la, p.lo], null);
      return Object.assign({}, p, { km: +r.km.toFixed(2), off: Math.round(r.off), on: r.off <= maxOff });
    }).sort((x, y) => x.km - y.km);
  }

  /** 前方的補給點（只取路線上的），kinds = 要顯示的類型集合 */
  function upcoming(pois, km, kinds, limit) {
    return pois
      .filter(p => p.on && p.km > km + 0.03 && kinds.has(p.t))
      .slice(0, limit || 20)
      .map(p => Object.assign({}, p, { dist: p.km - km }));
  }

  /** 從 OSM tags 判斷便利商店品牌 */
  function brandOf(tags) {
    const s = ((tags.brand || '') + ' ' + (tags.name || '') + ' ' + (tags['brand:zh'] || '')).toLowerCase();
    if (/7-?eleven|統一超商|7-11/.test(s)) return '7-11';
    if (/全家|familymart/.test(s)) return '全家';
    if (/萊爾富|hi-?life/.test(s)) return '萊爾富';
    if (/(^|\s)ok(\s|便|超|$)|ok mart/.test(s)) return 'OK';
    return '';
  }

  /** 把 Overpass 結果轉成 poi 清單 */
  function parseOverpass(elements) {
    const out = [];
    for (const e of elements) {
      const t = e.tags || {};
      const la = e.lat != null ? e.lat : (e.center && e.center.lat);
      const lo = e.lon != null ? e.lon : (e.center && e.center.lon);
      if (la == null || lo == null) continue;
      if (t.shop === 'convenience') {
        out.push({ n: t.name || '便利商店', la, lo, t: 'store', b: brandOf(t), extra: true });
      } else if (t.amenity === 'drinking_water') {
        out.push({ n: t.name || '飲水點', la, lo, t: 'water', b: '', extra: true });
      } else if (t.amenity === 'toilets') {
        out.push({ n: t.name || '公廁', la, lo, t: 'wc', b: '', extra: true });
      }
    }
    return out;
  }

  /** 去掉與既有點距離 < 80 m 的重複 */
  function mergePois(base, extra) {
    const out = base.slice();
    for (const x of extra) {
      if (!out.some(p => p.t === x.t && hv([p.la, p.lo], [x.la, x.lo]) < 80)) out.push(x);
    }
    return out;
  }

  /** 沿軌跡每隔 stepKm 取一個取樣點（給 Overpass around 用） */
  function samplePolyline(track, cum, fromKm, toKm, stepKm) {
    const out = [];
    let next = fromKm;
    for (let i = 0; i < track.length; i++) {
      if (cum[i] >= fromKm && cum[i] <= toKm && cum[i] >= next) {
        out.push([track[i][0], track[i][1]]);
        next = cum[i] + stepKm;
      }
    }
    return out;
  }

  const fmtKm = km => km >= 10 ? km.toFixed(1) : km.toFixed(2);
  function fmtDur(min) {
    min = Math.max(0, Math.round(min));
    const h = Math.floor(min / 60), m = min % 60;
    return h ? h + ' 小時 ' + m + ' 分' : m + ' 分';
  }

  return { hv, buildCum, ascentStats, projectOnSegment, snapToTrack, applyDetour, attachPois,
           upcoming, brandOf, parseOverpass, mergePois, samplePolyline, fmtKm, fmtDur };
});
