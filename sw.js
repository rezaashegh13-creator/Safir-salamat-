// sw.js — نسخه ۳ - با push و مدیریت بهتر آلارم

const CACHE_NAME = 'safir-salamat-v3';
const ASSETS_TO_CACHE = ['/Safir-salamat-/', '/Safir-salamat-/index.html'];

let currentSchedule = null;
let currentSoundData = null;
let alarmCheckInterval = null;

self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE_NAME).then(function(c) {
    return c.addAll(ASSETS_TO_CACHE).catch(function(){});
  }).then(function() { return self.skipWaiting(); }));
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(names.filter(function(n){ return n !== CACHE_NAME; }).map(function(n){ return caches.delete(n); }));
    }).then(function() { return self.clients.claim(); })
    .then(function() { startAlarmChecker(); })
  );
});

self.addEventListener('fetch', function(e) {
  if(e.request.method !== 'GET') return;
  if(e.request.url.indexOf('supabase.co') > -1) return;
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request).then(function(res) {
        if(res && res.status === 200) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(e.request, clone).catch(function(){}); });
        }
        return res;
      }).catch(function() { return caches.match('/Safir-salamat-/index.html'); });
    })
  );
});

/* ============ Message Handler ============ */
self.addEventListener('message', function(event) {
  var data = event.data || {};
  
  if(data.type === 'UPDATE_ALARM_SCHEDULE') {
    currentSchedule = data.data;
    console.log('[SW] Schedule:', currentSchedule ? currentSchedule.schedule.length : 0);
    startAlarmChecker();
  }
  if(data.type === 'SET_SOUND') {
    currentSoundData = data.data;
  }
  if(data.type === 'STOP_ALARM') {
    closeAllAlarmNotifications();
  }
  // ✅ مهم: ارسال برای Push - مدیریت اشتراک
  if(data.type === 'REGISTER_PUSH') {
    registerPush(data.vapidPublicKey);
  }
});

/* ============ Push ============ */
self.addEventListener('push', function(event) {
  console.log('[SW] Push received');
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}
  
  var title = data.title || '⏰ سفیر سلامت';
  var body = data.body || 'وقت دارو';
  
  var options = {
    body: body,
    icon: '/Safir-salamat-/icon-192.png',
    badge: '/Safir-salamat-/icon-192.png',
    tag: 'safir-push-alarm',
    requireInteraction: true,
    renotify: true,
    silent: false,
    vibrate: [800,200,800,200,800,200,800],
    data: { 
      alarmName: body, 
      alarmType: title,
      isAlarm: true,
      fromPush: true
    },
    actions: [
      { action: 'stop', title: '🔇 قطع آلارم' },
      { action: 'snooze', title: '💤 چرت ۱۰ دقیقه' }
    ]
  };
  
  event.waitUntil(
    self.registration.showNotification(title, options).then(function() {
      // اطلاع به همه client ها
      return notifyClients({type: 'TRIGGER_ALARM_FROM_SW', alarmData: {name: body, type: title}});
    })
  );
});

async function registerPush(vapidPublicKey) {
  if(!vapidPublicKey) return;
  try {
    var reg = self.registration;
    var sub = await reg.pushManager.getSubscription();
    if(!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      });
    }
    return sub;
  } catch(e) {
    console.warn('[SW] Push register failed:', e);
  }
}

function urlBase64ToUint8Array(base64String) {
  var padding = '='.repeat((4 - base64String.length % 4) % 4);
  var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  var rawData = atob(base64);
  var output = new Uint8Array(rawData.length);
  for(var i = 0; i < rawData.length; ++i) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

/* ============ Notification Click ============ */
self.addEventListener('notificationclick', function(event) {
  var n = event.notification;
  var action = event.action;
  var data = n.data || {};
  
  console.log('[SW] Notification click:', action);
  n.close();
  
  if(action === 'stop') {
    notifyClients({type: 'ALARM_ACTION', action: 'stop'});
    closeAllAlarmNotifications();
    return;
  }
  
  if(action === 'snooze') {
    notifyClients({type: 'ALARM_ACTION', action: 'snooze'});
    closeAllAlarmNotifications();
    scheduleSnoozeAlarm(data);
    return;
  }
  
  // کلیک ساده → قطع + باز کردن اپ
  notifyClients({type: 'ALARM_ACTION', action: 'stop'});
  closeAllAlarmNotifications();
  
  event.waitUntil(
    clients.matchAll({type: 'window', includeUncontrolled: true}).then(function(list) {
      for(var i = 0; i < list.length; i++) {
        if(list[i].url.indexOf('/Safir-salamat-/') > -1) {
          if('focus' in list[i]) return list[i].focus();
        }
      }
      if(clients.openWindow) return clients.openWindow('/Safir-salamat-/');
    })
  );
});

self.addEventListener('notificationclose', function(event) {
  var d = event.notification.data || {};
  if(d.isAlarm) {
    notifyClients({type: 'ALARM_ACTION', action: 'stop'});
  }
});

/* ============ Sync ============ */
self.addEventListener('sync', function(event) {
  if(event.tag === 'safir-alarm-sync') {
    event.waitUntil(checkAndTriggerAlarms());
  }
});

self.addEventListener('periodicsync', function(event) {
  if(event.tag === 'safir-check-alarms') {
    event.waitUntil(checkAndTriggerAlarms());
  }
});

/* ============ Alarm Checker ============ */
function startAlarmChecker() {
  if(alarmCheckInterval) clearInterval(alarmCheckInterval);
  alarmCheckInterval = setInterval(function() {
    checkAndTriggerAlarms();
  }, 30 * 1000);
  checkAndTriggerAlarms();
}

function checkAndTriggerAlarms() {
  if(!currentSchedule || !currentSchedule.schedule || !currentSchedule.schedule.length) {
    return Promise.resolve();
  }
  
  var now = new Date();
  var currentMinutes = now.getHours() * 60 + now.getMinutes();
  var todayKey = now.toDateString();
  
  var promises = currentSchedule.schedule.map(function(alarm) {
    var parts = alarm.time.split(':');
    var alarmMinutes = parseInt(parts[0]) * 60 + parseInt(parts[1]);
    
    if(currentMinutes === alarmMinutes) {
      var key = todayKey + '_' + alarm.time + '_' + alarm.col;
      return getFromStore('triggered').then(function(tr) {
        tr = tr || {};
        if(tr[key]) return;
        tr[key] = Date.now();
        var cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
        for(var k in tr) if(tr[k] < cutoff) delete tr[k];
        return saveToStore('triggered', tr).then(function() {
          return showAlarmNotification(alarm);
        });
      });
    }
    return Promise.resolve();
  });
  
  return Promise.all(promises);
}

function showAlarmNotification(alarm) {
  var opts = {
    body: alarm.name + ' — کلیک برای قطع',
    icon: '/Safir-salamat-/icon-192.png',
    badge: '/Safir-salamat-/icon-192.png',
    tag: 'safir-alarm-' + alarm.col,
    requireInteraction: true,
    renotify: true,
    silent: false,
    vibrate: (currentSchedule.vibrate || currentSchedule.vibrateOnly) ? [800,200,800,200,800,200,800,200,800] : [],
    data: { alarmName: alarm.name, alarmType: alarm.label, isAlarm: true, col: alarm.col },
    actions: [
      { action: 'stop', title: '🔇 قطع آلارم' },
      { action: 'snooze', title: '💤 چرت ۱۰ دقیقه' }
    ]
  };
  
  notifyClients({type: 'TRIGGER_ALARM_FROM_SW', alarmData: {name: alarm.name, type: alarm.label}});
  return self.registration.showNotification('⏰ ' + alarm.label, opts);
}

function closeAllAlarmNotifications() {
  return self.registration.getNotifications().then(function(list) {
    list.forEach(function(n) {
      if((n.data && n.data.isAlarm) || (n.tag && n.tag.indexOf('safir') > -1)) n.close();
    });
  });
}

function scheduleSnoozeAlarm(data) {
  saveToStore('snooze', {
    time: Date.now() + 10 * 60 * 1000,
    col: data.col || 'snooze',
    name: data.alarmName || 'یادآوری',
    label: data.alarmType || '🔔'
  });
  if('sync' in self.registration) {
    self.registration.sync.register('safir-alarm-sync').catch(function(){});
  }
}

/* ============ IndexedDB ============ */
function openDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open('safir_sw_db', 2);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if(!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror = function(e) { reject(e.target.error); };
  });
}

function saveToStore(key, val) {
  return openDB().then(function(db) {
    return new Promise(function(res, rej) {
      var tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = res;
      tx.onerror = function() { rej(tx.error); };
    });
  }).catch(function(){});
}

function getFromStore(key) {
  return openDB().then(function(db) {
    return new Promise(function(res, rej) {
      var tx = db.transaction('kv', 'readonly');
      var r = tx.objectStore('kv').get(key);
      r.onsuccess = function() { res(r.result); };
      r.onerror = function() { rej(r.error); };
    });
  }).catch(function(){ return null; });
}

function notifyClients(msg) {
  return self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(function(list) {
    list.forEach(function(c) { c.postMessage(msg); });
  });
}
