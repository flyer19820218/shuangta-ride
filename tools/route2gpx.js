// 把目前網頁使用的路線輸出成 GPX（給車錶用）。
// 用法：node tools/route2gpx.js 輸出.gpx [danjiang] [tainan]   （後面兩個是要啟用的改道段，預設只開淡江大橋）
const fs = require('fs'), path = require('path');
const C = require('../core.js');
const R = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'route.json'), 'utf8'));
const out = process.argv[2] || '雙塔.gpx';
const on = new Set(process.argv.length > 3 ? process.argv.slice(3) : ['danjiang']);
let T = R.track;
for (const d of R.detours.filter(d => on.has(d.id) && d.seg).sort((a, b) => b.a.idx - a.a.idx)) T = C.applyDetour(T, d.a, d.b, d.seg);
const cum = C.buildCum(T), esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const pois = C.attachPois(T, cum, R.pois, 300).filter(p => p.on && ['store', 'rest', 'food', 'cp'].includes(p.t) || p.on && p.t !== 'wc' && p.t !== 'water');
const km = cum[cum.length - 1];
let x = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="shuangta-ride" xmlns="http://www.topografix.com/GPX/1/1">\n';
x += '<metadata><name>雙塔 富貴角-鵝鑾鼻 ' + km.toFixed(1) + 'km</name></metadata>\n';
for (const p of pois) x += '<wpt lat="' + p.la + '" lon="' + p.lo + '"><name>' + esc('km' + Math.round(p.km) + ' ' + p.n) + '</name></wpt>\n';
x += '<trk><name>雙塔 ' + km.toFixed(1) + 'km</name><trkseg>\n';
for (const p of T) x += '<trkpt lat="' + p[0].toFixed(6) + '" lon="' + p[1].toFixed(6) + '"><ele>' + Math.round(p[2] || 0) + '</ele></trkpt>\n';
x += '</trkseg></trk>\n</gpx>\n';
fs.writeFileSync(out, x);
console.log(out, T.length + ' 點', km.toFixed(1) + ' km', pois.length + ' 個補給標記');
