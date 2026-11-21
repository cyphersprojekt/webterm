// Service worker mínimo: permite instalar la app. No cachea nada (todo va siempre al servidor).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
