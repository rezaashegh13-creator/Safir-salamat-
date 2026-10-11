// نسخه کش — هر بار تغییر دادی، این عدد رو عوض کن
var CACHE_NAME = 'safir-salamat-v1';
var urlsToCache = [
    '/Safir-salamat-/',
    '/Safir-salamat-/index.html',
    '/Safir-salamat-/manifest.json'
];
// نصب
self.addEventListener('install', function(event) {
    console.log('✅ Service Worker نصب شد');
    event.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            return cache.addAll(urlsToCache);
        })
    );
    self.skipWaiting();
});

// فعال‌سازی
self.addEventListener('activate', function(event) {
    console.log('✅ Service Worker فعال شد');
    event.waitUntil(
        caches.keys().then(function(cacheNames) {
            return Promise.all(
                cacheNames.map(function(cacheName) {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Fetch — استراتژی Network First
self.addEventListener('fetch', function(event) {
    // درخواست‌های JSONBin رو کش نکن
    if (event.request.url.indexOf('jsonbin.io') > -1) {
        return;
    }
    
    event.respondWith(
        fetch(event.request)
        .then(function(response) {
            // اگه موفق بود، از کش یه کپی بذار
            if (response && response.status === 200) {
                var responseClone = response.clone();
                caches.open(CACHE_NAME).then(function(cache) {
                    cache.put(event.request, responseClone);
                });
            }
            return response;
        })
        .catch(function() {
            // اگه آفلاین بود، از کش بده
            return caches.match(event.request);
        })
    );
});
