// TaskFlow Service Worker
const CACHE = 'taskflow-v1';

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });

// ===== Push Notification (from Firebase Cloud Messaging) =====
self.addEventListener('push', e => {
    const data = e.data ? e.data.json() : {};
    const title = data.title || 'TaskFlow';
    const body  = data.body  || '未完了のタスクがあります';
    const taskId = data.taskId || null;

    e.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon: 'https://maeno8778-sudo.github.io/taskflow/icon-192.png',
            badge: 'https://maeno8778-sudo.github.io/taskflow/icon-192.png',
            tag: taskId || 'taskflow',
            requireInteraction: true,
            vibrate: [200, 100, 200, 100, 200],
            data: { taskId, url: self.location.origin + '/taskflow/' },
            actions: [
                { action: 'done',  title: '✅ 完了' },
                { action: 'later', title: '⏰ あとで' },
            ],
        })
    );
});

// ===== Notification Click =====
self.addEventListener('notificationclick', e => {
    const n = e.notification;
    n.close();

    if (e.action === 'done') {
        // Notify all open clients to mark the task done
        e.waitUntil(
            clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
                cs.forEach(c => c.postMessage({ type: 'MARK_DONE', taskId: n.data && n.data.taskId }));
            })
        );
        return;
    }

    // Open / focus the app
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
            for (const c of cs) {
                if (c.url.includes('/taskflow') && 'focus' in c) return c.focus();
            }
            if (clients.openWindow) return clients.openWindow(n.data && n.data.url || '/taskflow/');
        })
    );
});

// ===== Messages from main thread =====
self.addEventListener('message', e => {
    if (!e.data) return;
    if (e.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    } else if (e.data.type === 'SHOW_NOTIFICATION') {
        // Show notification via SW (works when app is backgrounded on iOS PWA)
        self.registration.showNotification(e.data.title || 'TaskFlow', {
            body: e.data.body || '',
            tag: e.data.taskId || 'taskflow',
            requireInteraction: true,
            vibrate: [200, 100, 200],
            data: { taskId: e.data.taskId, url: self.location.origin + '/taskflow/' },
            actions: [
                { action: 'done',  title: '✅ 完了' },
                { action: 'later', title: '⏰ あとで' },
            ],
        });
    }
});
