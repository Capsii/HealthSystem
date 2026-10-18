const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const patientClientSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'patients.js'),
  'utf8',
);

function makePatientPage({ fetchImpl, confirmImpl = () => false }) {
  const listeners = new Map();
  const formListeners = new Map();
  const notifications = [];
  const redirects = [];
  const crypto = {
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
  };
  const button = {
    disabled: false,
    textContent: 'Save Patient',
  };
  const form = {
    reportValidity() {
      return true;
    },
    elements: {
      namedItem() {
        return {
          setCustomValidity() {},
          reportValidity() {},
        };
      },
    },
    addEventListener(type, listener) {
      formListeners.set(type, listener);
    },
    querySelector(selector) {
      return selector === 'button[type="submit"]' ? button : null;
    },
  };
  const document = {
    body: {
      dataset: { userId: 'synthetic-user', csrfToken: 'synthetic-csrf' },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    getElementById(id) {
      return id === 'addPatientForm' ? form : null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const window = {
    db: {
      async databaseReady() {
        return false;
      },
      async setCurrentUser() {
        throw new Error('Must not configure a failed local database.');
      },
      async savePatients() {
        throw new Error('No local database is available.');
      },
    },
    HealthSysUI: {
      notify(message, type, persistent) {
        notifications.push({ message, type, persistent });
      },
    },
    location: {
      pathname: '/patients',
      search: '?search=Synthetic&page=2',
      assign(url) {
        redirects.push(url);
      },
    },
    dispatchEvent() {},
    confirm: confirmImpl,
  };
  class TestFormData {
    constructor() {
      this.values = [
        ['full_name', 'Synthetic Patient'],
        ['date_of_birth', '1990-01-02'],
        ['gender', 'other'],
        ['phone', '+15555550123'],
        ['address', 'Synthetic test address'],
      ];
    }
    entries() {
      return this.values[Symbol.iterator]();
    }
  }
  const context = {
    window,
    document,
    FormData: TestFormData,
    navigator: { onLine: true },
    crypto,
    Event: class TestEvent {},
    CustomEvent: class TestCustomEvent {},
    console: { error() {}, warn() {} },
    fetch: fetchImpl,
    Date,
    URL,
    Object,
    String,
    RegExp,
    Number,
    Promise,
  };
  vm.runInNewContext(patientClientSource, context, {
    filename: 'server/public/js/patients.js',
  });
  return {
    button,
    document,
    form,
    formListeners,
    listeners,
    notifications,
    redirects,
  };
}

test('patient creation requires confirmation for server duplicate suggestions and rechecks on submit', async () => {
  const requests = [];
  const matchId = '33333333-3333-4333-8333-333333333333';
  const page = makePatientPage({
    confirmImpl: () => true,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/patients/json') {
        return {
          ok: true,
          async json() {
            return [];
          },
        };
      }
      if (
        requests.filter((request) => request.url === '/patients/add').length ===
        1
      ) {
        return {
          ok: false,
          status: 409,
          async json() {
            return {
              code: 'POTENTIAL_DUPLICATE',
              error: 'Possible patient match.',
              matches: [
                {
                  id: matchId,
                  full_name: 'Synthetic existing patient',
                  reasons: ['phone'],
                },
              ],
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { success: true, id: '22222222-2222-4222-8222-222222222222' };
        },
      };
    },
  });

  page.listeners.get('DOMContentLoaded')();
  await page.formListeners.get('submit')({
    currentTarget: page.form,
    preventDefault() {},
  });

  const addRequests = requests.filter(
    (request) => request.url === '/patients/add',
  );
  assert.equal(addRequests.length, 2);
  const initialPayload = JSON.parse(addRequests[0].options.body);
  const confirmedPayload = JSON.parse(addRequests[1].options.body);
  assert.equal(initialPayload.allowPotentialDuplicates, undefined);
  assert.equal(confirmedPayload.allowPotentialDuplicates, true);
  assert.deepEqual(confirmedPayload.duplicateAcknowledgedIds, [matchId]);
  assert.equal(page.redirects.length, 1);
  assert.equal(page.button.disabled, false);
});

test('patient creation cancellation after duplicate suggestions sends no confirmation request', async () => {
  let addRequests = 0;
  const page = makePatientPage({
    confirmImpl: () => false,
    fetchImpl: async (url) => {
      if (url === '/patients/json') {
        return {
          ok: true,
          async json() {
            return [];
          },
        };
      }
      addRequests++;
      return {
        ok: false,
        status: 409,
        async json() {
          return {
            code: 'POTENTIAL_DUPLICATE',
            error: 'Possible patient match.',
            matches: [
              {
                id: '33333333-3333-4333-8333-333333333333',
                full_name: 'Synthetic existing patient',
                reasons: ['phone'],
              },
            ],
          };
        },
      };
    },
  });

  page.listeners.get('DOMContentLoaded')();
  await page.formListeners.get('submit')({
    currentTarget: page.form,
    preventDefault() {},
  });

  assert.equal(addRequests, 1);
  assert.equal(page.redirects.length, 0);
  assert.ok(
    page.notifications.some((notification) =>
      notification.message.includes('No local or server record was changed'),
    ),
  );
  assert.equal(page.button.disabled, false);
});

test('patient form stays online-capable when local IndexedDB fails to open', async () => {
  const requests = [];
  const page = makePatientPage({
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/patients/json') {
        return {
          ok: true,
          async json() {
            return [];
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            success: true,
            id: '22222222-2222-4222-8222-222222222222',
          };
        },
      };
    },
  });

  page.listeners.get('DOMContentLoaded')();
  assert.equal(page.formListeners.has('submit'), true);
  await page.formListeners.get('submit')({
    currentTarget: page.form,
    preventDefault() {},
  });

  const createRequest = requests.find(
    (request) => request.url === '/patients/add',
  );
  assert.ok(createRequest);
  assert.equal(createRequest.options.method, 'POST');
  assert.equal(createRequest.options.headers['X-CSRF-Token'], 'synthetic-csrf');
  assert.deepEqual(page.redirects, [
    '/patients/22222222-2222-4222-8222-222222222222?returnTo=%2Fpatients%3Fsearch%3DSynthetic%26page%3D2',
  ]);
  assert.equal(page.button.disabled, false);
  assert.equal(page.button.textContent, 'Save Patient');
});

test('patient form restores its button and reports a failed server request', async () => {
  const page = makePatientPage({
    fetchImpl: async () => {
      return {
        ok: false,
        status: 400,
        async json() {
          return { error: 'Patient phone number is invalid.' };
        },
      };
    },
  });

  page.listeners.get('DOMContentLoaded')();
  await page.formListeners.get('submit')({
    currentTarget: page.form,
    preventDefault() {},
  });

  assert.equal(page.button.disabled, false);
  assert.equal(page.button.textContent, 'Save Patient');
  const serverError = page.notifications.find((notification) =>
    /phone number is invalid/i.test(notification.message),
  );
  assert.ok(serverError);
  assert.equal(serverError.type, 'error');
});
