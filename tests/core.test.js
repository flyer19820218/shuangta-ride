// 執行：node tests/core.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../core.js');

const R = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'route.json'), 'utf8'));
const T = R.track;
const cum = C.buildCum(T);
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('✓', name); };

ok('總里程約 505 km', () => assert.ok(Math.abs(cum[cum.length - 1] - R.meta.km) < 0.2, cum[cum.length - 1]));

ok('爬升統計與 route.json 一致（±10 m）', () => {
  const a = C.ascentStats(T, 2);
  assert.ok(Math.abs(a.up - R.meta.ascent) < 10, a.up + ' vs ' + R.meta.ascent);
  assert.strictEqual(a.cumUp.length, T.length);
});

ok('軌跡上的點吸附後 off≈0、km 正確', () => {
  const i = 2500;
  const r = C.snapToTrack(T, cum, [T[i][0], T[i][1]], null);
  assert.ok(r.off < 1, 'off ' + r.off);
  assert.ok(Math.abs(r.km - cum[i]) < 0.05, r.km + ' vs ' + cum[i]);
});

ok('偏離軌跡約 30 m 時 off 約 30', () => {
  const i = 1000, lat = T[i][0] + 0.00027; // ≈30 m
  const r = C.snapToTrack(T, cum, [lat, T[i][1]], i);
  assert.ok(r.off > 10 && r.off < 45, 'off ' + r.off);
});

ok('hint 過期（人跳到很遠的路段）會自動改全域搜尋', () => {
  const r = C.snapToTrack(T, cum, [T[4000][0], T[4000][1]], 100);
  assert.ok(Math.abs(r.km - cum[4000]) < 0.1, r.km);
});

ok('applyDetour：取代 a..b 並保留前後段', () => {
  const a = { idx: 100 }, b = { idx: 200 };
  const seg = [[T[100][0], T[100][1]], [T[100][0] + 0.01, T[100][1] + 0.01], [T[200][0], T[200][1]]];
  const out = C.applyDetour(T, a, b, seg);
  assert.strictEqual(out.length, T.length - (200 - 100 + 1) + 3 - 0);
  assert.deepStrictEqual(out.slice(0, 100), T.slice(0, 100));
  assert.strictEqual(out[100][0], T[100][0]);
  assert.deepStrictEqual(out.slice(103), T.slice(201));
  assert.ok(out.every(p => typeof p[2] === 'number'));
});

ok('attachPois：路線上的商店 on=true，離路線很遠的 on=false', () => {
  const P = C.attachPois(T, cum, R.pois, 600);
  const on = P.find(p => p.n.includes('永安港'));
  const off = P.find(p => p.n.includes('丹丹漢堡'));
  assert.ok(on && on.on, '永安港應在路線上');
  assert.ok(off && !off.on, '丹丹漢堡離路線 4 km 應為 off');
  for (let i = 1; i < P.length; i++) assert.ok(P[i].km >= P[i - 1].km, '需依里程排序');
});

ok('upcoming：只回傳前方、路線上、指定類型，且依距離排序', () => {
  const P = C.attachPois(T, cum, R.pois, 600);
  const u = C.upcoming(P, 100, new Set(['store', 'rest']), 5);
  assert.ok(u.length === 5);
  assert.ok(u.every(p => p.km > 100 && p.on && p.dist > 0));
  for (let i = 1; i < u.length; i++) assert.ok(u[i].dist >= u[i - 1].dist);
});

ok('brandOf', () => {
  assert.strictEqual(C.brandOf({ name: '7-ELEVEN 永安港門市' }), '7-11');
  assert.strictEqual(C.brandOf({ brand: '全家便利商店' }), '全家');
  assert.strictEqual(C.brandOf({ name: '萊爾富' }), '萊爾富');
  assert.strictEqual(C.brandOf({ name: 'OK便利商店 芳苑店' }), 'OK');
  assert.strictEqual(C.brandOf({ name: '某雜貨店' }), '');
});

ok('parseOverpass + mergePois 去重', () => {
  const els = [
    { type: 'node', lat: 24.98821, lon: 121.01853, tags: { shop: 'convenience', name: '7-ELEVEN 永安港門市' } },
    { type: 'way', center: { lat: 24.5, lon: 120.7 }, tags: { shop: 'convenience', name: '全家 某店' } },
    { type: 'node', lat: 24.4, lon: 120.6, tags: { amenity: 'drinking_water' } },
    { type: 'node', lat: 24.3, lon: 120.5, tags: { amenity: 'toilets', name: '公廁' } },
  ];
  const ex = C.parseOverpass(els);
  assert.strictEqual(ex.length, 4);
  const merged = C.mergePois(R.pois.map(p => ({ la: p.la, lo: p.lo, t: p.t, n: p.n })), ex);
  assert.strictEqual(merged.length, R.pois.length + 3, '第一筆與既有「永安港」重複應被去掉');
});

ok('samplePolyline 取樣間距約 1 km', () => {
  const s = C.samplePolyline(T, cum, 100, 140, 1);
  assert.ok(s.length >= 30 && s.length <= 42, s.length);   // 間隔「至少」1 km，所以會略少於 40 點
});

ok('fmtKm / fmtDur', () => {
  assert.strictEqual(C.fmtKm(505.3), '505.3');
  assert.strictEqual(C.fmtKm(12.34), '12.3');
  assert.strictEqual(C.fmtKm(2.345), '2.35');
  assert.strictEqual(C.fmtDur(80), '1 小時 20 分');
  assert.strictEqual(C.fmtDur(5), '5 分');
});

ok('bearing / compass8：四個基本方位與八方位名稱', () => {
  const o = [24, 121];
  assert.ok(Math.abs(C.bearing(o, [25, 121]) - 0) < 0.5, '正北');
  assert.ok(Math.abs(C.bearing(o, [24, 122]) - 90) < 1, '正東');
  assert.ok(Math.abs(C.bearing(o, [23, 121]) - 180) < 0.5, '正南');
  assert.ok(Math.abs(C.bearing(o, [24, 120]) - 270) < 1, '正西');
  assert.strictEqual(C.compass8(0), '北');
  assert.strictEqual(C.compass8(44), '東北');
  assert.strictEqual(C.compass8(92), '東');
  assert.strictEqual(C.compass8(200), '南');
  assert.strictEqual(C.compass8(359), '北');
  assert.strictEqual(C.compass8(-45), '西北');
});

ok('fmtDist', () => {
  assert.strictEqual(C.fmtDist(350.4), '350 m');
  assert.strictEqual(C.fmtDist(1234), '1.2 km');
});

ok('rejoinTarget：回路目標在行進方向前方約 150 m，且不會超出終點', () => {
  const i = C.rejoinTarget(cum, 2000, 0.15);
  assert.ok(i >= 2000 && cum[i] - cum[2000] >= 0.15 - 1e-9, '至少前進 0.15 km');
  assert.ok(cum[i] - cum[2000] < 0.15 + 1.8, '不會跳太遠（軌跡最大間距約 1.7 km）');
  assert.strictEqual(C.rejoinTarget(cum, cum.length - 1, 0.15), cum.length - 1);
  assert.strictEqual(C.rejoinTarget(cum, 500, 0), 500);
});

ok('stepText：轉彎文字', () => {
  assert.strictEqual(C.stepText({ maneuver: { type: 'turn', modifier: 'right' }, name: '台2線', distance: 350 }), '右轉，進入 台2線，350 m');
  assert.strictEqual(C.stepText({ maneuver: { type: 'depart', modifier: 'straight' }, name: '', distance: 1200 }), '出發，直行，1.2 km');
  assert.strictEqual(C.stepText({ maneuver: { type: 'arrive' }, name: '', distance: 0 }), '抵達路線');
  assert.strictEqual(C.stepText({ maneuver: { type: 'turn', modifier: 'slight left' }, name: '', distance: 80 }), '稍微左轉，80 m');
});

ok('route.json：改道段都帶有預先驗證的路線，且起終點貼近錨點', () => {
  for (const d of R.detours) {
    assert.ok(Array.isArray(d.seg) && d.seg.length > 50, d.id + ' 缺 seg');
    assert.ok(C.hv(d.seg[0], [d.a.lat, d.a.lon]) < 30, d.id + ' 起點偏離錨點');
    assert.ok(C.hv(d.seg[d.seg.length - 1], [d.b.lat, d.b.lon]) < 30, d.id + ' 終點偏離錨點');
  }
  const dj = R.detours.find(d => d.id === 'danjiang');
  const len = dj.seg.reduce((s, p, i) => i ? s + C.hv(dj.seg[i - 1], p) : 0, 0) / 1000;
  assert.ok(len > 9 && len < 11.5, '淡江大橋段長度 ' + len);
});

ok('destination：往各方向走 500 m，距離與方位都對', () => {
  const o = [24, 121];
  for (const b of [0, 45, 90, 180, 270, 333]) {
    const p = C.destination(o, b, 500);
    assert.ok(Math.abs(C.hv(o, p) - 500) < 1, b + '° 距離 ' + C.hv(o, p));
    assert.ok(Math.abs(C.angleDelta(C.bearing(o, p), b)) < 0.5, b + '° 方位 ' + C.bearing(o, p));
  }
});

ok('angleDelta / lerpAngle：走最短轉向（跨過 0°/360°）', () => {
  assert.strictEqual(C.angleDelta(350, 10), 20);
  assert.strictEqual(C.angleDelta(10, 350), -20);
  assert.strictEqual(C.angleDelta(0, 180) === 180 || C.angleDelta(0, 180) === -180, true);
  assert.ok(Math.abs(C.lerpAngle(350, 10, 0.5) - 0) < 1e-9 || Math.abs(C.lerpAngle(350, 10, 0.5) - 360) < 1e-9);
  assert.ok(Math.abs(C.lerpAngle(10, 350, 0.5) - 0) < 1e-9 || Math.abs(C.lerpAngle(10, 350, 0.5) - 360) < 1e-9);
  assert.ok(Math.abs(C.lerpAngle(0, 90, 0.35) - 31.5) < 1e-9);
  assert.ok(C.lerpAngle(0, 359, 1) > 358.9 && C.lerpAngle(0, 359, 1) <= 360);
});

console.log('\n全部通過：' + n + ' 項');
