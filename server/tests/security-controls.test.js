const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const {
  createHttpsRedirect,
  parseHttpsOrigin,
  parseTrustProxy,
} = require('../transport_security');
const { requireAuth } = require('../middleware/auth');
const pool = require('../db');

test('test identity headers cannot bypass production session checks', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTestAuthBypass = process.env.HEALTHSYS_TEST_AUTH_BYPASS;
  const originalExecute = pool.execute;
  let account = {
    id: 'synthetic-user',
    username: 'synthetic-user',
    role: 'staff',
    is_active: true,
    is_deleted: false,
    session_version: 2,
  };
  process.env.NODE_ENV = 'production';
  process.env.HEALTHSYS_TEST_AUTH_BYPASS = 'true';
  pool.execute = async (query) =>
    query.startsWith('SELECT')
      ? [[account]]
      : [{ affectedRows: 1 }];

  const request = (originalUrl, authVersion = 1) => ({
    headers: { accept: 'application/json' },
    originalUrl,
    is: () => false,
    get: (name) => (name === 'x-test-user' ? 'forged-test-user' : undefined),
    session: {
      user: {
        id: 'synthetic-user',
        username: 'synthetic-user',
        role: 'staff',
        authVersion,
      },
      destroy(callback) {
        callback(null);
      },
    },
  });
  const response = () => ({
    headers: {},
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  });

  try {
    for (const [url, currentAccount, authVersion] of [
      ['/sync', account, 1],
      [
        '/admin/staff/synthetic-user/status',
        { ...account, is_active: false },
        2,
      ],
    ]) {
      account = currentAccount;
      const res = response();
      await requireAuth(request(url, authVersion), res, () =>
        assert.fail('A forged test identity header must not bypass auth.'),
      );
      assert.equal(res.statusCode, 401);
      assert.equal(res.headers['Cache-Control'], 'no-store');
    }
  } finally {
    pool.execute = originalExecute;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalTestAuthBypass === undefined)
      delete process.env.HEALTHSYS_TEST_AUTH_BYPASS;
    else process.env.HEALTHSYS_TEST_AUTH_BYPASS = originalTestAuthBypass;
  }
});

test('unauthenticated JSON requests receive a no-store 401 instead of a login redirect', async () => {
  const headers = {};
  let responseStatus;
  let responseBody;
  let redirectLocation;
  const response = {
    set(name, value) {
      headers[name] = value;
      return this;
    },
    status(code) {
      responseStatus = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
    redirect(location) {
      redirectLocation = location;
      return this;
    },
  };
  await requireAuth(
    {
      headers: { accept: 'application/json' },
      is: () => false,
      session: null,
    },
    response,
    () => assert.fail('Unauthenticated requests must not continue.'),
  );
  assert.equal(responseStatus, 401);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.match(responseBody.error, /session is no longer valid/i);
  assert.equal(redirectLocation, undefined);
});

test('unauthenticated HTML requests retain the sign-in redirect', async () => {
  let redirectLocation;
  await requireAuth(
    {
      headers: { accept: 'text/html' },
      is: () => false,
      session: null,
    },
    {
      set() {},
      redirect(location) {
        redirectLocation = location;
      },
    },
    () => assert.fail('Unauthenticated requests must not continue.'),
  );
  assert.equal(redirectLocation, '/login');
});

test('production transport redirects unencrypted requests to a configured origin', () => {
  assert.equal(
    parseHttpsOrigin('https://healthsys.example/'),
    'https://healthsys.example',
  );
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('10.0.0.0/8'), '10.0.0.0/8');
  assert.equal(parseTrustProxy(undefined), false);
  assert.throws(
    () => parseHttpsOrigin('http://healthsys.example'),
    /HTTPS origin/,
  );
  assert.throws(
    () => parseHttpsOrigin('https://healthsys.example/path'),
    /HTTPS origin/,
  );

  const redirect = createHttpsRedirect(true, 'https://healthsys.example');
  let redirected;
  redirect(
    { secure: false, originalUrl: '/patients?status=deleted' },
    {
      redirect(status, location) {
        redirected = { status, location };
      },
    },
    () => assert.fail('Unencrypted requests must not reach the next handler.'),
  );
  assert.deepEqual(redirected, {
    status: 308,
    location: 'https://healthsys.example/patients?status=deleted',
  });
  let nextCalled = false;
  redirect(
    { secure: true, originalUrl: '/dashboard' },
    {
      set(name, value) {
        this.headers = { ...this.headers, [name]: value };
      },
      redirect() {
        assert.fail('Secure requests must not redirect.');
      },
    },
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, true);
  let insecurePostStatus;
  redirect(
    { secure: false, method: 'POST', originalUrl: '/login' },
    {
      status(code) {
        insecurePostStatus = code;
        return this;
      },
      send() {},
      redirect() {
        assert.fail('Insecure POST bodies must not be redirected.');
      },
    },
    () => assert.fail('Insecure POST bodies must not reach the next handler.'),
  );
  assert.equal(insecurePostStatus, 426);
});

test('service worker routes offline patient navigation to the local workspace, not cached server pages', async () => {
  const listeners = new Map();
  let fetchCalls = 0;
  const cache = {
    async match(key) {
      const value = typeof key === 'string' ? key : key.url;
      if (value.includes('/patients'))
        return new Response('STALE PRIVATE PATIENT DATA');
      if (value === '/offline-workspace.html')
        return new Response('Local patient workspace');
      if (value === '/offline.html')
        return new Response('Generic offline page');
      return undefined;
    },
    async put() {
      assert.fail('Private page responses must never be cached.');
    },
  };
  const context = {
    self: {
      navigator: { onLine: false },
      location: new URL('https://healthsys.example'),
      addEventListener(type, callback) {
        listeners.set(type, callback);
      },
    },
    caches: {
      async open() {
        return cache;
      },
    },
    location: { origin: 'https://healthsys.example' },
    URL,
    Request,
    Response,
    Headers,
    AbortController,
    Promise,
    setTimeout,
    clearTimeout,
    fetch: async () => {
      fetchCalls++;
      throw new Error('offline');
    },
    console: { log() {}, warn() {} },
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, '..', 'public', 'service-worker.js'),
      'utf8',
    ),
    context,
    { filename: 'server/public/service-worker.js' },
  );
  let responsePromise;
  listeners.get('fetch')({
    request: new Request('https://healthsys.example/patients?status=deleted', {
      headers: { accept: 'text/html' },
    }),
    respondWith(promise) {
      responsePromise = promise;
    },
  });
  const response = await responsePromise;
  assert.equal(await response.text(), 'Local patient workspace');
  assert.equal(response.headers.get('X-HealthSys-Offline-Fallback'), '1');
  assert.equal(fetchCalls, 0);
});

test('offline patient workspace loads the existing local database and patient mutation queue', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'offline-workspace.html'),
    'utf8',
  );
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'offline-workspace.js'),
    'utf8',
  );
  const sessionGuard = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'status.js'),
    'utf8',
  );
  assert.match(html, /\/js\/dexie\.min\.js/);
  assert.match(html, /\/js\/db\.js/);
  assert.match(html, /\/js\/offline-access\.js/);
  assert.match(html, /id="offlinePatientRows"/);
  assert.match(html, /id="offlinePatientForm"/);
  assert.match(html, /id="offlineEditForm"/);
  assert.match(script, /window\.db\.getPatients\(\)/);
  assert.match(script, /addLocalPatientAndQueue/);
  assert.match(script, /updateLocalPatientAndQueue/);
  assert.match(script, /queuePatientDeletion/);
  assert.match(script, /syncPendingData/);
  assert.match(html, /id="lockOfflineWorkspace"/);
  assert.match(script, /were not removed/);
  assert.match(script, /window\.HealthSysOfflineAccess\.clear\(\)/);
  assert.match(script, /local records remain available/);
  assert.match(script, /response\.status === 401/);
  assert.match(sessionGuard, /fetch\('\/session\/status'/);
  assert.match(sessionGuard, /content\.inert = true/);
  assert.match(sessionGuard, /window\.addEventListener\('offline'/);
  assert.match(sessionGuard, /local workspace remains available/);
  assert.doesNotMatch(sessionGuard, /lockPrivatePage\(\s*error/);
  const sharedUi = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'ui.js'),
    'utf8',
  );
  assert.match(sharedUi, /HealthSysOfflineAccess\?\.clear\(\)/);
});

test('offline dashboard, staff, and reports use only authorized local data sources', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'offline-portal.html'),
    'utf8',
  );
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'offline-portal.js'),
    'utf8',
  );
  const worker = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'service-worker.js'),
    'utf8',
  );
  assert.match(html, /\/js\/db\.js/);
  assert.match(html, /\/js\/offline-access\.js/);
  assert.match(script, /window\.db\.getPatients\(\)/);
  assert.match(script, /window\.db\.getDashboardMetrics\(\)/);
  assert.match(script, /window\.db\.syncPendingData\(\)/);
  assert.match(
    script,
    /Staff records and account changes are not stored on this device/,
  );
  assert.match(script, /Staff-account totals, sync-log history/);
  assert.match(script, /session\.user\.id !== context\.userId/);
  assert.match(script, /response\.status === 401/);
  assert.match(script, /page\.adminOnly && context\.role !== 'admin'/);
  assert.match(script, /HealthSys no longer confirms administrator access/);
  assert.match(script, /URL date-range filters are not applied/);
  assert.match(worker, /isOfflinePortalPath/);
  assert.match(worker, /response\.status >= 500/);
  assert.match(script, /Data recovery requires a connection/);
});

test('offline authorization context is bounded, account-specific, and invalidatable', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'offline-access.js'),
    'utf8',
  );
  const values = new Map();
  let now = 1_800_000_000_000;
  const window = {};
  const context = {
    window,
    localStorage: {
      getItem(key) {
        return values.get(key) || null;
      },
      setItem(key, value) {
        values.set(key, value);
      },
      removeItem(key) {
        values.delete(key);
      },
    },
    document: { body: { dataset: {} } },
    Date: { now: () => now },
    console: { error() {} },
  };
  vm.runInNewContext(script, context, { filename: 'offline-access.js' });
  const saved = window.HealthSysOfflineAccess.save({
    id: 'synthetic-user',
    username: 'synthetic-staff',
    role: 'staff',
  });
  assert.equal(saved.userId, 'synthetic-user');
  assert.equal(window.HealthSysOfflineAccess.read().role, 'staff');
  now += window.HealthSysOfflineAccess.maxAgeMs;
  assert.equal(window.HealthSysOfflineAccess.read(), null);
  window.HealthSysOfflineAccess.clear();
  assert.equal(values.size, 0);
});
