const CACHE = 'totaluxe-v3';
const SHELL = [
  '/totaluxe/',
  '/totaluxe/index.html',
  '/totaluxe/manifest.json',
  '/totaluxe/icons/icon-192.png',
  '/totaluxe/icons/icon-512.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if(url.pathname.startsWith('/api/')) return;
  if(url.hostname === 'cdnjs.cloudflare.com'){ e.respondWith(cacheFirst(e.request)); return; }
  if(url.pathname.startsWith('/totaluxe/')){
    // The app shell (HTML) is fetched network-first so new deploys are picked
    // up immediately — a stale cached HTML must never outlive a deploy. Other
    // assets (icons, fonts) stay cache-first for speed and offline support.
    const isHTML = e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html');
    e.respondWith(isHTML ? networkFirst(e.request) : cacheFirst(e.request));
  }
});
async function networkFirst(req){
  try{
    const res = await fetch(req);
    if(res.ok){ const c = await caches.open(CACHE); c.put(req, res.clone()); }
    return res;
  }catch{
    const cached = await caches.match(req);
    return cached || new Response('Offline — please reconnect.', { status:503, headers:{'Content-Type':'text/plain'} });
  }
}
async function cacheFirst(req){
  const cached = await caches.match(req);
  if(cached) return cached;
  try{
    const res = await fetch(req);
    if(res.ok){ const c = await caches.open(CACHE); c.put(req, res.clone()); }
    return res;
  }catch{
    return new Response('Offline — please reconnect.', { status:503, headers:{'Content-Type':'text/plain'} });
  }
}
