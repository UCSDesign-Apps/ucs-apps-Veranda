const CACHE = 'totaluxe-v1';
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
  if(url.pathname.startsWith('/totaluxe/')){ e.respondWith(cacheFirst(e.request)); }
});
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
