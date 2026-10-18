const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MessageChannel } = require('node:worker_threads');
const test = require('node:test');

const workerSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'service-worker.js'),
  'utf8',
);

class WorkerRequest {
  constructor(input, init = {}) {
    const source =
      input instanceof URL
        ? input.href
        : typeof input === 'string'
          ? input
          : input.url;
    this.url = new URL(source, 'https://healthsys.example').href;
    this.method = init.method || input.method || 'GET';
    this.mode = init.mode || input.mode || 'cors';
    this.redirect = init.redirect || input.redirect || 'follow';
    this.credentials = init.credentials || input.credentials || 'same-origin';
    this.headers = new Headers(init.headers || input.headers || {});
  }
}

function makeWorker({
  fetchImpl = async () => {
    throw new Error('offline');
  },
  clients = [],
} = {}) {
  const listeners = new Map();
  const entries = new Map();
  const cache = {
    async match(key) {
      const url = typeof key === 'string' ? key : new URL(key.url).pathname;
      return entries.get(url);
    },
    async put(key, response) {
      const url = typeof key === 'string' ? key : new URL(key.url).pathname;
      entries.set(url, response);
    },
    async keys() {
      return Array.from(entries.keys(), (url) => new WorkerRequest(url));
    },
    async delete(key) {
      const url = typeof key === 'string' ? key : new URL(key.url).pathname;
      return entries.delete(url);
    },
  };
  const cacheStores = new Map([
    ['healthsys-v34', new Map()],
    ['unrelated-cache', new Map()],
  ]);
  const caches = {
    async open(name) {
      if (!cacheStores.has(name)) cacheStores.set(name, new Map());
      const store = cacheStores.get(name);
      return {
        match: async (key) => {
          const response = store.get(
            typeof key === 'string' ? key : new URL(key.url).pathname,
          );
          return response?.clone();
        },
        put: async (key, value) =>
          store.set(
            typeof key === 'string' ? key : new URL(key.url).pathname,
            value.clone(),
          ),
        keys: async () =>
          Array.from(store.keys(), (url) => new WorkerRequest(url)),
        delete: async (key) =>
          store.delete(
            typeof key === 'string' ? key : new URL(key.url).pathname,
          ),
      };
    },
    async keys() {
      return Array.from(cacheStores.keys());
    },
    async delete(name) {
      return cacheStores.delete(name);
    },
  };
  const self = {
    location: new URL('https://healthsys.example/service-worker.js'),
    navigator: { onLine: true },
    clients: {
      async matchAll() {
        return clients;
      },
      async claim() {},
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    skipWaitingCalled: 0,
    async skipWaiting() {
      this.skipWaitingCalled++;
    },
  };
  const context = {
    self,
    caches,
    URL,
    Request: WorkerRequest,
    Response,
    Headers,
    AbortController,
    MessageChannel,
    Promise,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    console: { info() {} },
  };
  vm.runInNewContext(workerSource, context, { filename: 'service-worker.js' });
  return { listeners, self, caches, cacheStores, cache, entries };
}

test('service worker caches the required offline shell and waits instead of skipping automatically', async () => {
  const worker = makeWorker({
    fetchImpl: async (request) =>
      new Response(`asset:${new URL(request.url).pathname}`),
  });
  let installPromise;
  worker.listeners.get('install')({
    waitUntil(promise) {
      installPromise = promise;
    },
  });
  await installPromise;

  const shell = await worker.caches.open('healthsys-v54');
  for (const pathName of [
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
  ]) {
    assert.ok(
      await shell.match(pathName),
      `${pathName} should be installed in the shell cache`,
    );
  }
  assert.equal(worker.self.skipWaitingCalled, 0);
});

test('offline private navigation serves the patient workspace and portal for supported pages', async () => {
  const worker = makeWorker();
  const cache = await worker.caches.open('healthsys-v54');
  await cache.put(
    '/offline-workspace.html',
    new Response('Local patient workspace'),
  );
  await cache.put('/offline-portal.html', new Response('Local offline portal'));
  await cache.put('/offline.html', new Response('Generic offline fallback'));

  async function navigate(url) {
    let responsePromise;
    worker.listeners.get('fetch')({
      request: new WorkerRequest(url, { headers: { accept: 'text/html' } }),
      respondWith(promise) {
        responsePromise = promise;
      },
    });
    return responsePromise;
  }

  assert.equal(
    await (await navigate('https://healthsys.example/patients')).text(),
    'Local patient workspace',
  );
  assert.equal(
    await (
      await navigate('https://healthsys.example/patients/123/profile')
    ).text(),
    'Generic offline fallback',
  );
  for (const pathName of [
    '/dashboard',
    '/admin/staff',
    '/admin/reports',
    '/admin/recovery',
  ]) {
    assert.equal(
      await (await navigate(`https://healthsys.example${pathName}`)).text(),
      'Local offline portal',
    );
  }
  assert.equal(
    await (await navigate('https://healthsys.example/admin')).text(),
    'Generic offline fallback',
  );
});

test('online navigation follows server redirects instead of showing the offline page', async () => {
  const worker = makeWorker({
    fetchImpl: async (request) => {
      assert.equal(request.redirect, 'follow');
      assert.equal(new URL(request.url).pathname, '/login');
      return new Response(`page:${new URL(request.url).pathname}`);
    },
  });
  let responsePromise;
  worker.listeners.get('fetch')({
    request: new WorkerRequest('https://healthsys.example/', {
      mode: 'navigate',
    }),
    respondWith(promise) {
      responsePromise = promise;
    },
  });
  assert.equal(await (await responsePromise).text(), 'page:/login');
});

test('online navigation preserves server error responses instead of replacing them with offline HTML', async () => {
  const worker = makeWorker({
    fetchImpl: async () =>
      new Response('Database temporarily unavailable', { status: 503 }),
  });
  let responsePromise;
  worker.listeners.get('fetch')({
    request: new WorkerRequest('https://healthsys.example/patients', {
      headers: { accept: 'text/html' },
    }),
    respondWith(promise) {
      responsePromise = promise;
    },
  });

  const response = await responsePromise;
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'Database temporarily unavailable');
  assert.equal(response.headers.get('X-HealthSys-Offline-Fallback'), null);
});

test('dashboard, staff, reports, and recovery fall back locally when backend returns 5xx', async () => {
  const worker = makeWorker({
    fetchImpl: async () => new Response('Backend unavailable', { status: 503 }),
  });
  const cache = await worker.caches.open('healthsys-v54');
  await cache.put('/offline-portal.html', new Response('Local offline portal'));

  for (const pathName of [
    '/dashboard',
    '/admin/staff',
    '/admin/reports',
    '/admin/recovery',
  ]) {
    let responsePromise;
    worker.listeners.get('fetch')({
      request: new WorkerRequest(`https://healthsys.example${pathName}`, {
        headers: { accept: 'text/html' },
      }),
      respondWith(promise) {
        responsePromise = promise;
      },
    });
    const response = await responsePromise;
    assert.equal(await response.text(), 'Local offline portal');
    assert.equal(response.headers.get('X-HealthSys-Offline-Fallback'), '1');
  }
});

test('online navigation allows responses that take longer than the former short timeout', async () => {
  const worker = makeWorker({
    fetchImpl: async (_request, { signal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(new Response('Patient page')),
          2000,
        );
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      }),
  });
  let responsePromise;
  worker.listeners.get('fetch')({
    request: new WorkerRequest('https://healthsys.example/patients', {
      headers: { accept: 'text/html' },
    }),
    respondWith(promise) {
      responsePromise = promise;
    },
  });

  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'Patient page');
});

test('network-only API failures are explicit 503 JSON, never offline HTML', async () => {
  const worker = makeWorker();
  let responsePromise;
  worker.listeners.get('fetch')({
    request: new WorkerRequest('https://healthsys.example/session/status', {
      headers: { accept: 'application/json' },
    }),
    respondWith(promise) {
      responsePromise = promise;
    },
  });
  const response = await responsePromise;
  assert.equal(response.status, 503);
  assert.equal(
    response.headers.get('Content-Type'),
    'application/json; charset=utf-8',
  );
  assert.equal(response.headers.get('X-HealthSys-Network-Error'), '1');
  assert.equal((await response.json()).code, 'SERVER_UNAVAILABLE');
});

test('missing cached shell assets fail explicitly when offline', async () => {
  const worker = makeWorker();
  let responsePromise;
  worker.listeners.get('fetch')({
    request: new WorkerRequest('https://healthsys.example/js/dashboard.js'),
    respondWith(promise) {
      responsePromise = promise;
    },
  });

  const response = await responsePromise;
  assert.equal(response.status, 503);
  assert.match(await response.text(), /not available offline/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('private server responses and API responses are network-only; shell assets use the release cache', async () => {
  let fetchCount = 0;
  const worker = makeWorker({
    fetchImpl: async () => {
      fetchCount++;
      return new Response('live server response');
    },
  });
  const cache = await worker.caches.open('healthsys-v54');
  await cache.put('/style.css', new Response('release-pinned css'));

  let privateResponse;
  worker.listeners.get('fetch')({
    request: new WorkerRequest('https://healthsys.example/patients', {
      headers: { accept: 'text/html' },
    }),
    respondWith(promise) {
      privateResponse = promise;
    },
  });
  assert.equal(await (await privateResponse).text(), 'live server response');

  let apiResponse;
  worker.listeners.get('fetch')({
    request: new WorkerRequest('https://healthsys.example/patients/json'),
    respondWith(promise) {
      apiResponse = promise;
    },
  });
  assert.equal(await (await apiResponse).text(), 'live server response');

  let assetResponse;
  worker.listeners.get('fetch')({
    request: new WorkerRequest('https://healthsys.example/style.css'),
    respondWith(promise) {
      assetResponse = promise;
    },
  });
  assert.equal(await (await assetResponse).text(), 'release-pinned css');
  assert.equal(fetchCount, 2);
  assert.equal(await cache.match('/patients'), undefined);
  assert.equal(await cache.match('/patients/json'), undefined);
});

test('service worker activates only after clients confirm they are not writing or syncing', async () => {
  const client = {
    postMessage(message, ports) {
      if (message.type === 'CHECK_UPDATE_SAFETY') {
        ports[0].postMessage({ safe: true });
        ports[0].close();
      }
    },
  };
  const worker = makeWorker({ clients: [client] });
  let activationPromise;
  worker.listeners.get('message')({
    data: { type: 'ACTIVATE_UPDATE' },
    source: {
      postMessage() {
        assert.fail('Safe clients must not be blocked.');
      },
    },
    waitUntil(promise) {
      activationPromise = promise;
    },
  });
  await activationPromise;
  assert.equal(worker.self.skipWaitingCalled, 1);

  const busyWorker = makeWorker({
    clients: [
      {
        postMessage(message, ports) {
          if (message.type === 'CHECK_UPDATE_SAFETY') {
            ports[0].postMessage({ safe: false });
            ports[0].close();
          }
        },
      },
    ],
  });
  let blocked = false;
  let blockedPromise;
  busyWorker.listeners.get('message')({
    data: { type: 'ACTIVATE_UPDATE' },
    source: {
      postMessage(message) {
        blocked = message.type === 'ACTIVATION_BLOCKED';
      },
    },
    waitUntil(promise) {
      blockedPromise = promise;
    },
  });
  await blockedPromise;
  assert.equal(busyWorker.self.skipWaitingCalled, 0);
  assert.equal(blocked, true);
});
