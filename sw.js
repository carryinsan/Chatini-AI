self.addEventListener('install', (event) => {
    self.skipWaiting(); // Instantly take over
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', async (event) => {
    if (event.data && event.data.action === 'SCHEDULE_TASK') {
        const { task, timestamp } = event.data;
        const delay = timestamp - Date.now();
        
        if (delay <= 0) {
            self.registration.showNotification('LexisAI Sentinel', { body: task, icon: 'https://cdn-icons-png.flaticon.com/512/6819/6819071.png' });
            return;
        }

        // ====================================================================
        // THE 24x7 OS INJECTION: Notification Triggers API
        // Runs natively in the OS background even if the browser tab is closed!
        // ====================================================================
        if ('showTrigger' in Notification.prototype) {
            self.registration.showNotification('LexisAI Sentinel', {
                body: task,
                icon: 'https://cdn-icons-png.flaticon.com/512/6819/6819071.png',
                vibrate: [200, 100, 200, 100, 200], // Professional alert buzz
                showTrigger: new TimestampTrigger(timestamp) // Hands the timer over to the OS!
            });
        } else {
            // Fallback for browsers (like older Safari) that don't support OS-level triggers yet.
            // The Service Worker stays awake as long as possible.
            setTimeout(() => {
                self.registration.showNotification('LexisAI Sentinel', { 
                    body: task,
                    icon: 'https://cdn-icons-png.flaticon.com/512/6819/6819071.png',
                    vibrate: [200, 100, 200]
                });
            }, delay);
        }
    }
});

// If the user clicks the notification, open the LexisAI app back up
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(clientsArr => {
            if (clientsArr.length) {
                clientsArr[0].focus(); // Focus existing tab
            } else {
                clients.openWindow('/'); // Open new tab
            }
        })
    );
});
