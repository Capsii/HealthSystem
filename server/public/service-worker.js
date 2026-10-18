const CACHE_PREFIX = 'healthsys-';
const CACHE_NAME = 'healthsys-v54';
const APP_SHELL = [
  '/offline.html',
  '/offline-workspace.html',
  '/offline-workspace.css',
  '/offline-portal.html',
  '/offline-portal.css',
  '/js/offline-access.js',
  '/js/offline-workspace.js',
  '/js/offline-portal.js',
  '/js/offline-status.js',
  '/style.css',
  '/ui-modernization.css',
  '/manifest.json',
  '/js/db.js',
  '/js/dashboard.js',
  '/js/offline-recovery.js',
  '/js/admin-recovery.js',
  '/js/ui.js',
  '/js/status.js',
  '/js/sw-register.js',
  '/js/patients.js',
  '/js/dexie.min.js',
  '/icons/healthsys-192.png',
  '/icons/healthsys-512.png',
];
const PRIVATE_PATH_PREFIXES = [
  '/patients',
  '/appointments',
  '/dashboard',
  '/admin',
  '/account',
  '/register',
];
const NETWORK_TIMEOUT_MS = 10000;

function offlineFallbackResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('X-HealthSys-Offline-Fallback', '1');
  headers.set('Cache-Control', 'no-store');
  return response.blob().then(
    (body) =>
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
  );
}

function pathnameOf(request) {
  return new URL(request.url).pathname;
}

function isNavigation(request) {
  return (
    request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html')
  );
}

function isPrivatePath(pathname) {
  return PRIVATE_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isOfflinePortalPath(pathname) {
  return (
    pathname === '/dashboard' ||
    pathname === '/admin/staff' ||
    pathname === '/admin/reports' ||
    pathname === '/admin/recovery'
  );
}

function isCacheableShellPath(pathname) {
  return APP_SHELL.includes(pathname);
}

function diagnostic(message, details = '') {
  if (
    self.location.hostname === 'localhost' ||
    self.location.hostname === '127.0.0.1'
  ) {
    console.info(`[SW] ${message}`, details);
  }
}

async function cacheShell() {
  const cache = await caches.open(CACHE_NAME);
  const results = await Promise.all(
    APP_SHELL.map(async (path) => {
      try {
        const response = await fetch(new Request(path, { cache: 'reload' }));
        if (!response.ok || response.type === 'opaque') {
          diagnostic(
            'Shell resource was not cached.',
            `${path} (${response.status})`,
          );
          return false;
        }
        await cache.put(path, response);
        return true;
      } catch (error) {
        diagnostic(
          'Shell resource fetch failed.',
          `${path} (${error?.name || 'network error'})`,
        );
        return false;
      }
    }),
  );
  const requiredCached = await Promise.all(
    [
      '/offline.html',
      '/offline-workspace.html',
      '/offline-workspace.css',
      '/offline-portal.html',
      '/offline-portal.css',
      '/js/offline-access.js',
      '/js/offline-workspace.js',
      '/js/offline-portal.js',
      '/js/offline-status.js',
      '/style.css',
      '/ui-modernization.css',
      '/js/db.js',
      '/js/dexie.min.js',
    ].map(async (path) => Boolean(await cache.match(path))),
  );
  if (requiredCached.some((present) => !present)) {
    await caches.delete(CACHE_NAME);
    throw new Error(
      'Required HealthSys offline shell resources could not be cached.',
    );
  }
  diagnostic(
    'Install shell caching complete.',
    `${results.filter(Boolean).length}/${APP_SHELL.length}`,
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    cacheShell().then(() => {
      diagnostic('Worker installed and waiting for a safe update.');
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      diagnostic('Worker activated; obsolete HealthSys caches removed.');
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'GET_VERSION') {
    event.ports?.[0]?.postMessage({ version: CACHE_NAME });
    return;
  }
  if (event.data?.type === 'ACTIVATE_UPDATE') {
    event.waitUntil(
      (async () => {
        const clients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        const replies = await Promise.all(
          clients.map(
            (client) =>
              new Promise((resolve) => {
                const channel = new MessageChannel();
                const timeout = setTimeout(() => {
                  channel.port1.close();
                  resolve({ safe: null });
                }, 3000);
                channel.port1.onmessage = (messageEvent) => {
                  clearTimeout(timeout);
                  channel.port1.close();
                  resolve(messageEvent.data || { safe: false });
                };
                client.postMessage({ type: 'CHECK_UPDATE_SAFETY' }, [
                  channel.port2,
                ]);
              }),
          ),
        );
        if (replies.some((reply) => reply.safe === false)) {
          event.source?.postMessage({ type: 'ACTIVATION_BLOCKED' });
          diagnostic('Update activation postponed while a client is busy.');
          return;
        }
        await self.skipWaiting();
      })(),
    );
    return;
  }
  if (event.data?.type === 'clear-private-cache') {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const requests = await cache.keys();
        await Promise.all(
          requests
            .filter((request) => isPrivatePath(pathnameOf(request)))
            .map((request) => cache.delete(request)),
        );
      })(),
    );
  }
});

async function getCachedOfflinePage(cache) {
  const response =
    (await cache.match('/offline.html')) ||
    new Response(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>HealthSys offline</title><p>HealthSys cannot reach the server. Reconnect and retry.</p></html>',
      {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    );
  return offlineFallbackResponse(response);
}

async function offlineNavigationResponse(request, cache) {
  const pathname = pathnameOf(request);
  if (pathname === '/patients') {
    const response =
      (await cache.match('/offline-workspace.html')) ||
      (await getCachedOfflinePage(cache));
    return offlineFallbackResponse(response);
  }
  if (isOfflinePortalPath(pathname)) {
    const response =
      (await cache.match('/offline-portal.html')) ||
      (await getCachedOfflinePage(cache));
    return offlineFallbackResponse(response);
  }
  return getCachedOfflinePage(cache);
}

async function fetchWithTimeout(request, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await fetch(request, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  const pathname = pathnameOf(request);
  if (!self.navigator.onLine) {
    diagnostic(
      'Device reports offline; serving the offline workspace.',
      pathname,
    );
    return offlineNavigationResponse(request, cache);
  }
  try {
    const networkRequest =
      pathname === '/'
        ? new Request(new URL('/login', request.url), {
            headers: request.headers,
            credentials: request.credentials,
            cache: 'no-store',
            redirect: 'follow',
          })
        : new Request(request, {
            cache: 'no-store',
            mode: 'cors',
            redirect: 'follow',
          });
    const response = await fetchWithTimeout(networkRequest);
    if (isOfflinePortalPath(pathname) && response.status >= 500) {
      diagnostic(
        'Page backend is unavailable; serving the offline portal.',
        `${pathname} (HTTP ${response.status})`,
      );
      return offlineNavigationResponse(request, cache);
    }
    if (isPrivatePath(pathname)) return response;
    if (
      response.headers.get('Cache-Control')?.toLowerCase().includes('no-store')
    )
      return response;
    return response;
  } catch (error) {
    diagnostic(
      'Navigation is unavailable; returning generic offline page.',
      `${pathname} (${error?.name || 'network error'})`,
    );
    return offlineNavigationResponse(request, cache);
  }
}

async function cacheFirstShellAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const pathname = pathnameOf(request);
  const cached = await cache.match(pathname);
  if (cached) return cached;
  try {
    return await fetchWithTimeout(request, { cache: 'no-store' });
  } catch (error) {
    diagnostic(
      'Cached shell resource unavailable.',
      `${pathname} (${error?.name || 'network error'})`,
    );
    return new Response(
      'This HealthSys resource is not available offline. Reconnect and retry.',
      {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    );
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const pathname = url.pathname;

  if (isNavigation(request)) {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (
    pathname === '/health' ||
    pathname === '/session/status' ||
    pathname === '/patients/json' ||
    pathname === '/dashboard/metrics' ||
    pathname.startsWith('/admin/recovery')
  ) {
    event.respondWith(
      fetchWithTimeout(request, { cache: 'no-store' }).catch(
        () =>
          new Response(
            JSON.stringify({
              error:
                'HealthSys could not be reached. No server action was confirmed.',
              code: 'SERVER_UNAVAILABLE',
            }),
            {
              status: 503,
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-HealthSys-Network-Error': '1',
              },
            },
          ),
      ),
    );
    return;
  }

  if (isCacheableShellPath(pathname)) {
    event.respondWith(cacheFirstShellAsset(request));
  }
});
