// public/sw.js - Background Worker Interface Engine
self.addEventListener('push', function(event) {
    if (!event.data) return;
    
    const payload = event.data.json();
    
    const options = {
        body: payload.body,
        icon: '/uploads/logo-icon.png', // Add custom icon path if needed
        badge: '/uploads/logo-icon.png',
        tag: 'voice-call-request',
        renotify: true,
        requireInteraction: true, // Keeps the notification on screen until interacted with
        data: {
            url: `/chat.html?id=${payload.relationshipId}&name=${encodeURIComponent(payload.callerName)}&autoAnswer=true`
        }
    };

    event.waitUntil(
        self.registration.showNotification(payload.title, options)
    );
});

// Open application window interface when the notification card is tapped
self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            // If tab already open, focus it
            for (let i = 0; i < clientList.length; i++) {
                let client = clientList[i];
                if (client.url.includes('/chat.html') && 'focus' in client) {
                    return client.focus();
                }
            }
            // If tab closed, open a new instance directly to the call deck
            if (clients.openWindow) {
                return clients.openWindow(event.notification.data.url);
            }
        })
    );
});