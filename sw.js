self.addEventListener('install', (event) => {
    self.skipWaiting(); // Instantly take over
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.action === 'SCHEDULE_TASK') {
        const { task, timestamp } = event.data;
        const delay = timestamp - Date.now();
        
        // Wrap everything in waitUntil so the OS doesn't kill the worker before scheduling finishes
        event.waitUntil(
            (async () => {
                if (delay <= 0) {
                    await self.registration.showNotification('LexisAI Sentinel', { 
                        body: task, 
                        icon: 'https://cdn-icons-png.flaticon.com/512/6819/6819071.png',
                        vibrate: [200, 100, 200]
                    });
                    return;
                }

                // ====================================================================
                // THE 24x7 OS INJECTION: Notification Triggers API
                // Runs natively in the OS background even if the browser tab is closed!
                // ====================================================================
                if ('showTrigger' in Notification.prototype) {
                    await self.registration.showNotification('LexisAI Sentinel', {
                        body: task,
                        icon: 'https://cdn-icons-png.flaticon.com/512/6819/6819071.png',
                        vibrate: [200, 100, 200, 100, 200], // Professional alert buzz
                        showTrigger: new TimestampTrigger(timestamp) // Hands the timer over to the OS!
                    });
                } else {
                    // Fallback for browsers (like Safari/Firefox) that don't support OS-level triggers yet.
                    // The Service Worker stays awake as long as possible using setTimeout.
                    setTimeout(() => {
                        self.registration.showNotification('LexisAI Sentinel', { 
                            body: task,
                            icon: 'https://cdn-icons-png.flaticon.com/512/6819/6819071.png',
                            vibrate: [200, 100, 200]
                        });
                    }, delay);
                }
            })()
        );
    }
});

// If the user clicks the notification, open the LexisAI app back up
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientsArr => {
            if (clientsArr.length) {
                return clientsArr[0].focus(); // Focus existing tab
            } else {
                return clients.openWindow('/'); // Open new tab
            }
        })
    );
});
