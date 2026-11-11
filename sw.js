/* 離線快取：程式與路線資料優先用網路（有網路就是最新），沒訊號時退回快取。 */
const VER = 'shuangta-v3';
const TILES = 'shuangta-tiles';
const SHELL = [
  './', 'index.html', 'app.js', 'core.js', 'route.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => { })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== VER && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILES), ks = await c.keys();
  if (ks.length > 1500) await Promise.all(ks.slice(0, ks.length - 1200).map(k => c.delete(k)));
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;

  // 路由、Overpass 等 API：一律走網路，不快取
  if (/routing\.openstreetmap\.de|overpass-api\.de/.test(url.host)) return;

  // 地圖圖磚：快取優先，看過的區域沒訊號也能顯示
  if (/tile\.openstreetmap\.org$/.test(url.host)) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) { c.put(req, res.clone()); trimTiles(); }
        return res;
      } catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }

  // Leaflet（unpkg）：快取優先
  if (url.host === 'unpkg.com') {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone(); caches.open(VER).then(c => c.put(req, copy)); return res;
    })));
    return;
  }

  // 本站檔案：網路優先，失敗退回快取
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VER).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('index.html'))));
  }
});
