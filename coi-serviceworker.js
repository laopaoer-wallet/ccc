const POLICY_HEADERS = [
    ['Cross-Origin-Embedder-Policy', 'require-corp'],
    ['Cross-Origin-Opener-Policy', 'same-origin']
];

const addIsolationHeaders = (response) => {
    const newHeaders = new Headers(response.headers);
    POLICY_HEADERS.forEach(([key, value]) => newHeaders.set(key, value));
    return new Headers(newHeaders);
};

self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    if (request.method !== 'GET') {
        return;
    }

    const requestUrl = new URL(request.url);
    if (requestUrl.origin !== self.location.origin) {
        return;
    }

    event.respondWith((async () => {
        try {
            const response = await fetch(request);

            if (!response || response.status === 0 || response.type === 'opaqueredirect') {
                return response;
            }

            const headers = addIsolationHeaders(response);
            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers
            });
        } catch (error) {
            console.error('[coi] 代理失败:', error);
            return fetch(request);
        }
    })());
});
