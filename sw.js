// sw.js — Service Worker برای سفیر سلامت حامی
// نسخه ۲ - با آلارم پس‌زمینه و مدیریت اکشن‌های نوتیفیکیشن

const CACHE_NAME = 'safir-salamat-v2';
const ASSETS_TO_CACHE = [
  '/Safir-salamat-/',
  '/Safir-salamat-/index.html',
  '/Safir-salamat-/icon-192.png',
  '/Safir-salamat-/icon-512.png'
];

let currentSchedule = null;
let currentSoundData = null;
let alarmCheckInterval = null;
let activeAlarmNotifications = {};

// ============ Install ============
self.addEventListener('install', function(event) {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(ASSETS_TO_CACHE).catch(function(e){
        console.warn('Cache addAll failed:', e);
      });
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// ============ Activate ============
self.addEventListener('activate', function(event) {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n){ return n !== CACHE_NAME; })
          .map(function(n){ return caches.delete(n); })
      );
    }).then(function() {
      return self.clients.claim();
    }).then(function() {
      startAlarmChecker();
    })
  );
});

// ============ Fetch ============
self.addEventListener('fetch', function(event) {
  if(event.request.method !== 'GET') return;
  if(event.request.url.indexOf('supabase.co') > -1) return;
  
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if(cached) return cached;
      return fetch(event.request).then(function(response) {
        if(response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone).catch(function(){});
          });
        }
        return response;
      }).catch(function() {
        return caches.match('/Safir-salamat-/index.html');
      });
    })
  );
});

// ============ Message from app ============
self.addEventListener('message', function(event) {
  var data = event.data || {};
  
  if(data.type === 'UPDATE_ALARM_SCHEDULE') {
    currentSchedule = data.data;
    console.log('[SW] Alarm schedule updated:', currentSchedule ? currentSchedule.schedule.length : 0, 'alarms');
    startAlarmChecker();
  }
  
  if(data.type === 'SET_SOUND') {
    currentSoundData = data.data;
    console.log('[SW] Sound set:', currentSoundData ? 'yes' : 'no');
  }
  
  if(data.type === 'STOP_ALARM') {
    // بستن همه نوتیفیکیشن‌های آلارم
    closeAllAlarmNotifications();
  }
  
  if(data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ============ Notification Click ============
self.addEventListener('notificationclick', function(event) {
  var notification = event.notification;
  var action = event.action;
  var data = notification.data || {};
  
  console.log('[SW] Notification click:', action, data);
  
  notification.close();
  
  if(action === 'stop') {
    // قطع آلارم - اطلاع به اپ
    notifyClients({type: 'ALARM_ACTION', action: 'stop'});
    closeAllAlarmNotifications();
    return;
  }
  
  if(action === 'snooze') {
    // چرت 10 دقیقه
    notifyClients({type: 'ALARM_ACTION', action: 'snooze'});
    closeAllAlarmNotifications();
    // زمان‌بندی مجدد 10 دقیقه بعد
    scheduleSnoozeAlarm(data);
    return;
  }
  
  // کلیک روی خود نوتیفیکیشن → باز کردن اپ + قطع آلارم
  notifyClients({type: 'ALARM_ACTION', action: 'stop'});
  closeAllAlarmNotifications();
  
  event.waitUntil(
    clients.matchAll({type: 'window', includeUncontrolled: true}).then(function(clientList) {
      for(var i = 0; i < clientList.length; i++) {
        if(clientList[i].url.indexOf('/Safir-salamat-/') > -1) {
          if('focus' in clientList[i]) return clientList[i].focus();
        }
      }
      if(clients.openWindow) return clients.openWindow('/Safir-salamat-/');
    })
  );
});

// ============ Notification Close ============
self.addEventListener('notificationclose', function(event) {
  var data = event.notification.data || {};
  if(data.isAlarm) {
    notifyClients({type: 'ALARM_ACTION', action: 'stop'});
  }
});

// ============ Background Sync ============
self.addEventListener('sync', function(event) {
  if(event.tag === 'safir-alarm-sync') {
    event.waitUntil(checkAndTriggerAlarms());
  }
});

// ============ Periodic Sync (Background) ============
self.addEventListener('periodicsync', function(event) {
  if(event.tag === 'safir-check-alarms') {
    event.waitUntil(checkAndTriggerAlarms());
  }
});

// ============ آلارم Checker ============
function startAlarmChecker() {
  if(alarmCheckInterval) clearInterval(alarmCheckInterval);
  
  // چک هر 30 ثانیه
  alarmCheckInterval = setInterval(function() {
    checkAndTriggerAlarms();
  }, 30 * 1000);
  
  // چک فوری
  checkAndTriggerAlarms();
}

function checkAndTriggerAlarms() {
  if(!currentSchedule || !currentSchedule.schedule || currentSchedule.schedule.length === 0) {
    return Promise.resolve();
  }
  
  var now = new Date();
  var currentMinutes = now.getHours() * 60 + now.getMinutes();
  var todayKey = now.toDateString();
  
  var promises = currentSchedule.schedule.map(function(alarm) {
    var parts = alarm.time.split(':');
    var alarmMinutes = parseInt(parts[0]) * 60 + parseInt(parts[1]);
    
    // اگر دقیقه فعلی با زمان آلارم برابر است
    if(currentMinutes === alarmMinutes) {
      var alarmKey = todayKey + '_' + alarm.time + '_' + alarm.col;
      
      // بررسی اینکه قبلا این آلارم رو نشون ندادیم
      return getFromStore('triggered_alarms').then(function(triggered) {
        triggered = triggered || {};
        
        if(triggered[alarmKey]) return; // قبلا نشون داده شده
        
        // علامت زدن
        triggered[alarmKey] = Date.now();
        
        // پاک کردن آلارم‌های قدیمی
        var cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
        for(var k in triggered) {
          if(triggered[k] < cutoff) delete triggered[k];
        }
        
        return saveToStore('triggered_alarms', triggered).then(function() {
          return showAlarmNotification(alarm);
        });
      });
    }
    return Promise.resolve();
  });
  
  return Promise.all(promises);
}

function showAlarmNotification(alarm) {
  var notifOptions = {
    body: alarm.name + ' — برای قطع یا چرت روی نوتیفیکیشن کلیک کنید',
    icon: '/Safir-salamat-/icon-192.png',
    badge: '/Safir-salamat-/icon-192.png',
    tag: 'safir-alarm-' + alarm.col,
    requireInteraction: true,
    renotify: true,
    silent: false,
    vibrate: currentSchedule && currentSchedule.vibrate ? [500,200,500,200,500,200,500,200,500] : [],
    data: { 
      alarmName: alarm.name, 
      alarmType: alarm.label,
      isAlarm: true,
      col: alarm.col,
      action: 'open'
    },
    actions: [
      { action: 'stop', title: '🔇 قطع آلارم' },
      { action: 'snooze', title: '💤 چرت ۱۰ دقیقه' }
    ]
  };
  
  // اضافه کردن صدا اگر ممکن باشد
  if(currentSoundData) {
    notifOptions.sound = currentSoundData; // در بعضی مرورگرها پشتیبانی می‌شود
  }
  
  activeAlarmNotifications[alarm.col] = true;
  
  // اطلاع به اپ‌های باز برای نمایش اورلی
  notifyClients({type: 'TRIGGER_ALARM_FROM_SW', alarmData: {name: alarm.name, type: alarm.label}});
  
  return self.registration.showNotification('⏰ ' + alarm.label, notifOptions);
}

function closeAllAlarmNotifications() {
  return self.registration.getNotifications({tag: /^safir-alarm-/}).then(function(notifications) {
    notifications.forEach(function(n) { n.close(); });
  }).catch(function(e) {
    // fallback
    return self.registration.getNotifications().then(function(notifications) {
      notifications.forEach(function(n) {
        if(n.data && n.data.isAlarm) n.close();
      });
    });
  });
}

function scheduleSnoozeAlarm(data) {
  // ذخیره برای چک 10 دقیقه بعد
  var snoozeTime = new Date(Date.now() + 10 * 60 * 1000);
  var minutes = snoozeTime.getHours() * 60 + snoozeTime.getMinutes();
  
  saveToStore('snooze_alarms', {
    time: snoozeTime.getTime(),
    col: data.col || 'snooze',
    name: data.alarmName || 'یادآوری',
    label: data.alarmType || '🔔'
  });
  
  // تلاش برای ثبت Background Sync
  if('sync' in self.registration) {
    self.registration.sync.register('safir-alarm-sync').catch(function(){});
  }
}

// ============ IndexedDB Helpers ============
function openDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open('safir_sw_db', 1);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if(!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror = function(e) { reject(e.target.error); };
  });
}

function saveToStore(key, value) {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  }).catch(function(e) {
    console.warn('IndexedDB save failed:', e);
  });
}

function getFromStore(key) {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('kv', 'readonly');
      var req = tx.objectStore('kv').get(key);
      req.onsuccess = function() { resolve(req.result); };
      req.onerror = function() { reject(req.error); };
    });
  }).catch(function(e) {
    console.warn('IndexedDB get failed:', e);
    return null;
  });
}

// ============ Helper ============
function notifyClients(message) {
  return self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(function(clientList) {
    clientList.forEach(function(client) {
      client.postMessage(message);
    });
  });
}
