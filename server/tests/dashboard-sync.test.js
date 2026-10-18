const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

class MemoryTable {
  constructor() {
    this.rows = new Map();
    this.nextId = 1;
  }

  async toArray() {
    return Array.from(this.rows.values(), (row) => structuredClone(row));
  }

  async count() {
    return this.rows.size;
  }

  async add(row) {
    const id = row.id || this.nextId++;
    if (this.rows.has(id)) throw new Error('Duplicate key');
    this.rows.set(id, { ...structuredClone(row), id });
    return id;
  }

  async put(row) {
    this.rows.set(row.id, structuredClone(row));
  }

  async get(id) {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async update(id, changes) {
    const row = this.rows.get(id);
    if (!row) return 0;
    this.rows.set(id, { ...row, ...structuredClone(changes) });
    return 1;
  }

  async delete(id) {
    this.rows.delete(id);
  }

  async clear() {
    this.rows.clear();
  }

  toCollection() {
    return {
      filter: (predicate) => ({
        delete: async () => {
          for (const [id, row] of this.rows) {
            if (predicate(structuredClone(row))) this.rows.delete(id);
          }
        },
        modify: async (changes) => {
          for (const [id, row] of this.rows) {
            if (predicate(structuredClone(row))) {
              this.rows.set(id, { ...row, ...structuredClone(changes) });
            }
          }
        },
      }),
    };
  }

  async bulkDelete(ids) {
    ids.forEach((id) => this.rows.delete(id));
  }

  where(field) {
    return {
      equals: (value) => ({
        toArray: async () =>
          (await this.toArray()).filter((row) => row[field] === value),
      }),
    };
  }
}

class MemoryDexie {
  constructor() {
    this.patients = new MemoryTable();
    this.syncQueue = new MemoryTable();
    this.dashboardMetrics = new MemoryTable();
  }

  async open() {
    return this;
  }

  version() {
    const version = {
      stores() {
        return version;
      },
      upgrade() {
        return version;
      },
    };
    return version;
  }

  async transaction(_mode, ...args) {
    const callback = args.pop();
    const snapshots = args.map((table) => ({
      table,
      rows: new Map(table.rows),
      nextId: table.nextId,
    }));
    try {
      return await callback();
    } catch (error) {
      for (const snapshot of snapshots) {
        snapshot.table.rows = snapshot.rows;
        snapshot.table.nextId = snapshot.nextId;
      }
      throw error;
    }
  }
}

function makeSyncClient({
  online = true,
  fetchImpl,
  storage = new Map(),
  dbOpenFailure = false,
  databaseState = null,
  locks = null,
} = {}) {
  const state = databaseState || {
    patients: new MemoryTable(),
    syncQueue: new MemoryTable(),
    dashboardMetrics: new MemoryTable(),
  };
  const events = [];
  const window = {
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
  };
  const localStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
  };
  class TestCustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  class TestDexie extends MemoryDexie {
    constructor() {
      super();
      this.patients = state.patients;
      this.syncQueue = state.syncQueue;
      this.dashboardMetrics = state.dashboardMetrics;
    }
  }
  class FailingOpenDexie extends TestDexie {
    async open() {
      throw new Error('synthetic IndexedDB open failure');
    }
  }
  const context = {
    window,
    Dexie: dbOpenFailure ? FailingOpenDexie : TestDexie,
    document: { body: { dataset: { csrfToken: 'test-csrf' } } },
    navigator: { onLine: online, locks },
    localStorage,
    CustomEvent: TestCustomEvent,
    fetch:
      fetchImpl ||
      (async () => {
        throw new Error('Unexpected fetch call');
      }),
    console: { log() {}, warn() {}, error() {} },
    Date,
    Set,
    Number,
    JSON,
    Promise,
    Error,
    structuredClone,
    crypto: { randomUUID },
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'db.js'),
      'utf8',
    ),
    context,
    { filename: 'server/public/js/db.js' },
  );
  window.db.userId = 'integration-user';
  return { db: window.db, storage, events, window, databaseState: state };
}

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] || null;
      },
    },
    async json() {
      return body;
    },
  };
}

function acknowledgedOperations(options, statuses = []) {
  const operations = JSON.parse(options.body);
  return {
    success: true,
    complete: true,
    processed: operations.length,
    conflicts: 0,
    skipped: 0,
    resolvedIndexes: operations.map((_operation, index) => index),
    results: operations.map((operation, index) => ({
      operationId: operation.operationId,
      status: statuses[index] || 'applied',
      serverRecord: {
        id: operation.data.id,
        version: Number(operation.data.version) || 1,
        full_name: operation.data.full_name || 'Synthetic patient',
        is_deleted: false,
      },
    })),
  };
}

async function makeOfflineDashboard(role) {
  const eventListeners = new Map();
  const domListeners = new Map();
  const elements = new Map();
  const staffCards = [{ hidden: false }, { hidden: false }];
  const document = {
    body: { dataset: { userRole: role } },
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          textContent: '',
          hidden: false,
          dataset: {},
          style: {},
          setAttribute() {},
          removeAttribute() {},
          append() {},
          replaceChildren() {},
        });
      }
      return elements.get(id);
    },
    createElement(tagName) {
      return {
        tagName,
        children: [],
        append(child) {
          this.children.push(child);
        },
        addEventListener() {},
        set textContent(value) {
          this.text = value;
        },
        get textContent() {
          return this.text || '';
        },
      };
    },
    querySelectorAll() {
      return staffCards;
    },
    addEventListener(type, callback) {
      domListeners.set(type, callback);
    },
  };
  const window = {
    dispatchEvent(event) {
      for (const callback of eventListeners.get(event.type) || [])
        callback(event);
      return true;
    },
    addEventListener(type, callback) {
      const listeners = eventListeners.get(type) || [];
      listeners.push(callback);
      eventListeners.set(type, listeners);
    },
  };
  const storage = new Map();
  const localStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
  };
  class TestCustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const context = {
    window,
    document,
    Dexie: MemoryDexie,
    navigator: { onLine: false },
    localStorage,
    CustomEvent: TestCustomEvent,
    fetch: async () => {
      throw new Error('offline');
    },
    console: { log() {}, warn() {}, error() {} },
    Date,
    Set,
    Number,
    JSON,
    Promise,
    Error,
    structuredClone,
    crypto: { randomUUID },
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'db.js'),
      'utf8',
    ),
    context,
    { filename: 'server/public/js/db.js' },
  );
  context.window.db.userId = 'offline-dashboard-user';
  await context.window.db.saveDashboardMetrics({
    patients: { total: 2, active: 2, deleted: 0 },
    staff: { total: 3, active: 2, inactive: 1 },
  });
  const offlinePatientId = randomUUID();
  await context.window.db.addLocalPatient({ id: offlinePatientId });
  await context.window.db.queueAction('ADD', 'patients', {
    id: offlinePatientId,
  });
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'dashboard.js'),
      'utf8',
    ),
    context,
    { filename: 'server/public/js/dashboard.js' },
  );
  await domListeners.get('DOMContentLoaded')();
  return { document, elements, staffCards };
}

test('dashboard local sync queue lifecycle', async (t) => {
  await t.test(
    'offline dashboard reports local patients, queue, and cached staff snapshot',
    async () => {
      const { elements, staffCards } = await makeOfflineDashboard('admin');
      assert.equal(elements.get('patientTotal').textContent, '1');
      assert.equal(elements.get('patientActive').textContent, '1');
      assert.equal(elements.get('patientDeleted').textContent, 'Unavailable');
      assert.equal(elements.get('queueCount').textContent, '1');
      assert.match(elements.get('metricsSource').textContent, /this device/);
      assert.equal(elements.get('staffTotal').textContent, '3');
      assert.equal(elements.get('staffActive').textContent, '2');
      assert.equal(
        staffCards.every((card) => !card.hidden),
        true,
      );
    },
  );

  await t.test(
    'offline cached staff metrics remain hidden from non-admin users',
    async () => {
      const { staffCards } = await makeOfflineDashboard('staff');
      assert.equal(
        staffCards.every((card) => card.hidden),
        true,
      );
    },
  );

  await t.test(
    'counts offline patient additions and persists failed attempt across reload',
    async () => {
      const client = makeSyncClient({ online: false });
      const patientId = randomUUID();
      await client.db.addLocalPatient({
        id: patientId,
        full_name: 'Offline test',
      });
      await client.db.queueAction('ADD', 'patients', {
        id: patientId,
        full_name: 'Offline test',
      });

      assert.deepEqual(
        JSON.parse(JSON.stringify(await client.db.getQueueStatus())),
        {
          total: 1,
          pending: 1,
          processing: 0,
          failed: 0,
          conflicts: 0,
          reviewRequired: 0,
        },
      );

      const result = await client.db.syncPendingData();
      assert.equal(result.success, false);
      assert.match(result.error, /offline/);
      assert.equal((await client.db.syncQueue.toArray()).length, 1);
      assert.equal((await client.db.getQueueStatus()).pending, 1);
      assert.equal((await client.db.getQueueStatus()).failed, 0);
      assert.equal(client.db.getSyncMetadata().lastOutcome, 'Failure');

      const reloaded = makeSyncClient({
        online: false,
        storage: client.storage,
        databaseState: client.databaseState,
      });
      assert.equal(reloaded.db.getSyncMetadata().lastOutcome, 'Failure');
      assert.ok(reloaded.db.getSyncMetadata().lastAttemptAt);
      assert.equal(await reloaded.db.syncQueue.count(), 1);
    },
  );

  await t.test(
    'rate limiting rejects requests after the configured window quota',
    () => {
      const { createRateLimiter } = require('../rate_limit');
      const limiter = createRateLimiter({ windowMs: 60000, max: 2 });
      let passed = 0;
      let statusCode;
      const makeResponse = () => ({
        headers: {},
        set(name, value) {
          this.headers[name] = value;
        },
        status(code) {
          statusCode = code;
          return this;
        },
        send(message) {
          this.message = message;
        },
      });
      for (let index = 0; index < 3; index++) {
        limiter({ ip: '192.0.2.5', socket: {} }, makeResponse(), () => {
          passed++;
        });
      }
      assert.equal(passed, 2);
      assert.equal(statusCode, 429);
    },
  );

  await t.test(
    'offline patient and queue writes are atomic and carry a stable operation UUID',
    async () => {
      const client = makeSyncClient({ online: false });
      const id = randomUUID();
      const operationId = randomUUID();
      const quotaError = new Error('Synthetic storage quota exceeded');
      quotaError.name = 'QuotaExceededError';
      const originalAdd = client.db.syncQueue.add;
      client.db.syncQueue.add = async () => {
        throw quotaError;
      };
      await assert.rejects(
        client.db.addLocalPatientAndQueue(
          { id, full_name: 'Atomic test' },
          operationId,
        ),
        (error) => error.name === 'QuotaExceededError',
      );
      assert.equal(await client.db.getPatient(id), undefined);
      assert.equal(await client.db.syncQueue.count(), 0);

      client.db.syncQueue.add = originalAdd;
      await client.db.addLocalPatientAndQueue(
        { id, full_name: 'Atomic test' },
        operationId,
      );
      const [queued] = await client.db.syncQueue.toArray();
      assert.equal(queued.operationId, operationId);
      assert.equal(queued.ownerId, client.window.db.userId);
      assert.equal(queued.payload.id, id);
    },
  );

  await t.test(
    'offline patient edits persist across reload and sync using the expected version',
    async () => {
      const patientId = randomUUID();
      const client = makeSyncClient({ online: false });
      await client.db.addLocalPatient({
        id: patientId,
        version: 3,
        full_name: 'Original synthetic patient',
        date_of_birth: '1990-05-12',
        gender: 'female',
        phone: '5551234567',
        address: '1 Test Street',
      });

      await client.db.updateLocalPatientAndQueue(
        {
          id: patientId,
          full_name: 'Updated synthetic patient',
          date_of_birth: '1990-05-12',
          gender: 'female',
          phone: '5551234567',
          address: '2 Test Street',
        },
        3,
      );
      const [firstOperation] = await client.db.syncQueue.toArray();
      await client.db.updateLocalPatientAndQueue(
        {
          id: patientId,
          full_name: 'Updated synthetic patient',
          date_of_birth: '1990-05-12',
          gender: 'female',
          phone: '5550001111',
          address: '3 Test Street',
        },
        3,
      );
      const [coalescedOperation] = await client.db.syncQueue.toArray();
      assert.equal(coalescedOperation.operationId, firstOperation.operationId);
      assert.equal(coalescedOperation.payload.phone, '5550001111');
      assert.equal(await client.db.syncQueue.count(), 1);
      const reloaded = makeSyncClient({
        online: true,
        databaseState: client.databaseState,
        fetchImpl: async (_url, options) => {
          const [operation] = JSON.parse(options.body);
          assert.equal(operation.type, 'EDIT');
          assert.equal(operation.data.version, 3);
          return response({
            ...acknowledgedOperations(options),
            results: [
              {
                operationId: operation.operationId,
                status: 'applied',
                serverRecord: {
                  ...operation.data,
                  version: 4,
                  is_deleted: false,
                },
              },
            ],
          });
        },
      });

      const local = await reloaded.db.getPatient(patientId);
      const [queued] = await reloaded.db.syncQueue.toArray();
      assert.equal(local.full_name, 'Updated synthetic patient');
      assert.equal(local.address, '3 Test Street');
      assert.equal(local.pendingSync, true);
      assert.equal(queued.payload.version, 3);

      const result = await reloaded.db.syncPendingData();
      assert.equal(result.success, true);
      assert.equal(await reloaded.db.syncQueue.count(), 0);
      const synchronized = await reloaded.db.getPatient(patientId);
      assert.equal(synchronized.full_name, 'Updated synthetic patient');
      assert.equal(synchronized.address, '3 Test Street');
      assert.equal(synchronized.version, 4);
      assert.equal(synchronized.pendingSync, undefined);
    },
  );

  await t.test(
    'failed patient data can be corrected without changing its operation ID',
    async () => {
      let requestCount = 0;
      const patientId = randomUUID();
      const client = makeSyncClient({
        fetchImpl: async (_url, options) => {
          requestCount++;
          const [operation] = JSON.parse(options.body);
          if (requestCount === 1) {
            return response({
              success: true,
              complete: false,
              results: [
                {
                  operationId: operation.operationId,
                  status: 'failed',
                  code: 'VALIDATION_FAILED',
                  reason: 'Enter a valid date of birth.',
                },
              ],
            });
          }
          return response(acknowledgedOperations(options));
        },
      });
      await client.db.queueAction('ADD', 'patients', {
        id: patientId,
        full_name: 'Needs correction',
      });
      assert.equal((await client.db.syncPendingData()).success, false);
      const [failed] = await client.db.syncQueue.toArray();
      const operationId = failed.operationId;

      await assert.rejects(
        client.db.correctFailedOperation(failed.id, {
          full_name: 'Corrected patient',
          date_of_birth: '2025-02-30',
          gender: 'female',
          phone: '5551234567',
          address: '3 Test Street',
        }),
        /real date of birth/,
      );
      assert.equal((await client.db.syncQueue.get(failed.id)).status, 'failed');

      const corrected = await client.db.correctFailedOperation(failed.id, {
        full_name: 'Corrected patient',
        date_of_birth: '1992-08-17',
        gender: 'female',
        phone: '5551234567',
        address: '3 Test Street',
      });
      assert.equal(corrected.operationId, operationId);
      assert.equal((await client.db.syncQueue.get(failed.id)).status, 'pending');
      assert.equal((await client.db.syncPendingData()).success, true);
      assert.equal(await client.db.syncQueue.count(), 0);
      assert.equal(requestCount, 2);
    },
  );

  await t.test(
    'switching accounts hides cached patient data and preserves the other account queue',
    async () => {
      const client = makeSyncClient({ online: false });
      const firstUser = randomUUID();
      const secondUser = randomUUID();
      const patientId = randomUUID();
      await client.db.setCurrentUser(firstUser);
      await client.db.addLocalPatientAndQueue({
        id: patientId,
        full_name: 'Account scoped',
      });
      await client.db.setCurrentUser(secondUser);
      assert.deepEqual(await client.db.getPatients(), []);
      assert.equal(await client.db.syncQueue.count(), 1);
      assert.equal((await client.db.getQueueStatus()).total, 0);
    },
  );

  await t.test(
    'successful sync clears confirmed work and persists success time across reload',
    async () => {
      const storage = new Map();
      let fetchCount = 0;
      let submittedOperations;
      let releaseFetch;
      const fetchGate = new Promise((resolve) => {
        releaseFetch = resolve;
      });
      const client = makeSyncClient({
        storage,
        fetchImpl: async (_url, options) => {
          fetchCount++;
          submittedOperations = JSON.parse(options.body);
          await fetchGate;
          return response({
            ...acknowledgedOperations(options),
            syncedAt: '2026-10-12T00:00:00.000Z',
          });
        },
      });
      await client.db.queueAction('ADD', 'patients', { id: randomUUID() });
      const [queuedAction] = await client.db.syncQueue.toArray();
      const first = client.db.syncPendingData();
      const duplicate = client.db.syncPendingData();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(fetchCount, 1);
      assert.equal(
        submittedOperations[0].operationId,
        queuedAction.operationId,
      );
      releaseFetch();
      const [firstResult, duplicateResult] = await Promise.all([
        first,
        duplicate,
      ]);
      assert.equal(firstResult.success, true);
      assert.equal(duplicateResult.success, true);
      assert.equal(await client.db.syncQueue.count(), 0);
      assert.equal(
        client.db.getSyncMetadata().lastSuccessfulAt,
        '2026-10-12T00:00:00.000Z',
      );

      const reloaded = makeSyncClient({ storage });
      assert.equal(
        reloaded.db.getSyncMetadata().lastSuccessfulAt,
        '2026-10-12T00:00:00.000Z',
      );
    },
  );

  await t.test('failed requests retain every operation for retry', async () => {
    const client = makeSyncClient({
      fetchImpl: async () => response({ error: 'Database unavailable' }, 500),
    });
    await client.db.queueAction('ADD', 'patients', { id: randomUUID() });
    const [queuedBeforeFailure] = await client.db.syncQueue.toArray();
    const result = await client.db.syncPendingData();
    assert.equal(result.success, false);
    assert.match(result.error, /could not be confirmed/);
    assert.equal(await client.db.syncQueue.count(), 1);
    assert.equal((await client.db.getQueueStatus()).failed, 1);
    const failedAction = (await client.db.syncQueue.toArray())[0];
    assert.equal(failedAction.retryable, true);
    assert.equal(failedAction.operationId, queuedBeforeFailure.operationId);
    assert.equal(client.db.getSyncMetadata().lastSuccessfulAt, undefined);

    let retriedOperationId;
    await client.db.syncQueue.update(failedAction.id, {
      nextRetryAt: '2000-01-01T00:00:00.000Z',
    });
    const reloaded = makeSyncClient({
      databaseState: client.databaseState,
      fetchImpl: async (_url, options) => {
        retriedOperationId = JSON.parse(options.body)[0].operationId;
        return response(acknowledgedOperations(options));
      },
    });
    const retried = await reloaded.db.syncPendingData();
    assert.equal(retried.success, true);
    assert.equal(retriedOperationId, queuedBeforeFailure.operationId);
    assert.equal(await reloaded.db.syncQueue.count(), 0);
  });

  await t.test(
    'connection loss before receipt, transaction rollback, and lost acknowledgement retry idempotently',
    async () => {
      let requestCount = 0;
      let committedOperationId = null;
      let commitCount = 0;
      const sentOperationIds = [];
      const client = makeSyncClient({
        fetchImpl: async (_url, options) => {
          requestCount++;
          const [operation] = JSON.parse(options.body);
          sentOperationIds.push(operation.operationId);

          if (requestCount === 1) {
            throw new TypeError('Synthetic disconnect before server receipt');
          }
          if (requestCount === 2) {
            return response({ error: 'Synthetic transaction rolled back' }, 503);
          }
          if (requestCount === 3) {
            committedOperationId = operation.operationId;
            commitCount++;
            throw new TypeError('Synthetic response lost after commit');
          }

          if (committedOperationId === operation.operationId) {
            return response({
              success: true,
              complete: true,
              processed: 1,
              conflicts: 0,
              skipped: 0,
              results: [
                {
                  operationId: operation.operationId,
                  status: 'already_applied',
                  serverRecord: {
                    ...operation.data,
                    version: 1,
                    is_deleted: false,
                  },
                },
              ],
            });
          }

          committedOperationId = operation.operationId;
          commitCount++;
          return response(acknowledgedOperations(options));
        },
      });
      const patientId = randomUUID();
      await client.db.addLocalPatientAndQueue(
        { id: patientId, full_name: 'Synthetic retry patient' },
        randomUUID(),
      );
      const [initialAction] = await client.db.syncQueue.toArray();

      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await client.db.syncPendingData({
          forceRetry: attempt > 1,
        });
        assert.equal(result.success, false);
        const [retained] = await client.db.syncQueue.toArray();
        assert.equal(retained.operationId, initialAction.operationId);
        assert.equal(retained.payload.id, patientId);
      }

      const retry = await client.db.syncPendingData({ forceRetry: true });
      assert.equal(retry.success, true);
      assert.equal(requestCount, 4);
      assert.deepEqual(
        sentOperationIds,
        Array.from({ length: 4 }, () => initialAction.operationId),
      );
      assert.equal(commitCount, 1);
      assert.equal(await client.db.syncQueue.count(), 0);
      assert.equal(
        (await client.db.getPatient(patientId)).pendingSync,
        undefined,
      );
    },
  );

  await t.test(
    'authentication rejection retains patient records and queue without treating it as success',
    async () => {
      let requestCount = 0;
      const client = makeSyncClient({
        fetchImpl: async () => {
          requestCount++;
          return response({ error: 'Sign in again' }, 401);
        },
      });
      const patientId = randomUUID();
      await client.db.addLocalPatientAndQueue({
        id: patientId,
        full_name: 'Synthetic pending patient',
      });
      const [queuedBefore] = await client.db.syncQueue.toArray();

      const result = await client.db.syncPendingData();
      assert.equal(result.success, false);
      assert.equal(requestCount, 1);
      assert.equal(await client.db.syncQueue.count(), 1);
      const [queuedAfter] = await client.db.syncQueue.toArray();
      assert.equal(queuedAfter.operationId, queuedBefore.operationId);
      assert.equal(
        (await client.db.getPatient(patientId)).full_name,
        'Synthetic pending patient');
      assert.equal(client.db.getSyncMetadata().lastSuccessfulAt, undefined);
    },
  );

  await t.test(
    'interrupted operations are made retryable after the sync lock is acquired',
    async () => {
      const client = makeSyncClient({
        locks: {
          async request(_name, callback) {
            return callback();
          },
        },
      });
      await client.db.queueAction('ADD', 'patients', { id: randomUUID() });
      const [action] = await client.db.syncQueue.toArray();
      await client.db.syncQueue.update(action.id, {
        status: 'inProgress',
        syncStartedAt: new Date().toISOString(),
      });
      await client.db.recoverInterruptedSync();
      const recovered = await client.db.syncQueue.get(action.id);
      assert.equal(recovered.status, 'failed');
      assert.equal(recovered.retryable, true);
      assert.equal(recovered.operationId, action.operationId);
    },
  );

  await t.test(
    'retryable HTTP failures honor Retry-After and retain their operation ID',
    async () => {
      let requestCount = 0;
      let firstOperationId;
      let secondOperationId;
      const client = makeSyncClient({
        fetchImpl: async (_url, options) => {
          requestCount++;
          const [operation] = JSON.parse(options.body);
          firstOperationId ||= operation.operationId;
          if (requestCount === 2) secondOperationId = operation.operationId;
          if (requestCount === 1) {
            return response({ error: 'Temporary limit' }, 429, {
              'retry-after': '120',
            });
          }
          return response(acknowledgedOperations(options));
        },
      });
      await client.db.queueAction('ADD', 'patients', { id: randomUUID() });
      const firstResult = await client.db.syncPendingData();
      assert.equal(firstResult.success, false);
      const [failed] = await client.db.syncQueue.toArray();
      assert.equal(failed.retryable, true);
      assert.ok(Date.parse(failed.nextRetryAt) - Date.now() >= 119000);

      const waitingResult = await client.db.syncPendingData();
      assert.equal(waitingResult.partial, true);
      assert.equal(requestCount, 1);

      const forcedRetry = await client.db.syncPendingData({
        forceRetry: true,
      });
      assert.equal(forcedRetry.success, true);
      assert.equal(requestCount, 2);
      assert.equal(await client.db.syncQueue.count(), 0);
      assert.equal(firstOperationId, secondOperationId);
    },
  );

  await t.test(
    'malformed queue operations are retained for review and never sent',
    async () => {
      let submitted;
      const client = makeSyncClient({
        fetchImpl: async (_url, options) => {
          submitted = JSON.parse(options.body);
          return response(acknowledgedOperations(options));
        },
      });
      await client.db.queueAction('ADD', 'patients', {
        id: randomUUID(),
        full_name: 'Valid synthetic record',
      });
      await client.db.queueAction('EDIT', 'patients', {
        id: randomUUID(),
        full_name: 'Malformed synthetic record',
      });
      const queue = await client.db.syncQueue.toArray();
      await client.db.syncQueue.update(queue[1].id, { store: 'users' });

      const result = await client.db.syncPendingData();
      assert.equal(submitted.length, 1);
      assert.equal(result.success, false);
      assert.equal(result.unresolved, 1);
      const retained = await client.db.syncQueue.toArray();
      assert.equal(retained.length, 1);
      assert.equal(retained[0].store, 'users');
      assert.equal(retained[0].status, 'failed');
    },
  );

  await t.test(
    'partial response removes only server-confirmed operations',
    async () => {
      const client = makeSyncClient({
        fetchImpl: async (_url, options) => {
          const operations = JSON.parse(options.body);
          return response({
            success: true,
            complete: false,
            processed: 1,
            conflicts: 1,
            skipped: 0,
            resolvedIndexes: [0],
            conflictDetails: [{ index: 1, reason: 'version_mismatch' }],
            results: [
              {
                operationId: operations[0].operationId,
                status: 'applied',
                serverRecord: { id: operations[0].data.id, version: 1 },
              },
              {
                operationId: operations[1].operationId,
                status: 'conflict',
                code: 'VERSION_MISMATCH',
                reason: 'The patient changed on the server.',
                serverRecord: {
                  id: operations[1].data.id,
                  version: 2,
                  full_name: 'Server version',
                },
              },
            ],
          });
        },
      });
      const confirmedId = randomUUID();
      const conflictedId = randomUUID();
      await client.db.queueAction('ADD', 'patients', { id: confirmedId });
      await client.db.queueAction('EDIT', 'patients', {
        id: conflictedId,
        version: 1,
      });
      const result = await client.db.syncPendingData();
      assert.equal(result.success, false);
      assert.equal(result.partial, true);
      assert.equal(result.processed, 1);
      const queue = await client.db.syncQueue.toArray();
      assert.equal(queue.length, 1);
      assert.equal(queue[0].payload.id, conflictedId);
      assert.equal(queue[0].status, 'conflict');
      assert.equal(queue[0].conflictServer.full_name, 'Server version');
      assert.equal(queue[0].payload.id, conflictedId);
      assert.equal(client.db.getSyncMetadata().lastSuccessfulAt, undefined);
    },
  );

  await t.test(
    'conflicts preserve both versions and rebase only after an explicit local choice',
    async () => {
      const client = makeSyncClient({
        fetchImpl: async (_url, options) => {
          const [operation] = JSON.parse(options.body);
          return response({
            success: true,
            complete: false,
            processed: 0,
            conflicts: 1,
            skipped: 0,
            results: [
              {
                operationId: operation.operationId,
                status: 'conflict',
                code: 'VERSION_MISMATCH',
                reason: 'The patient changed on the server.',
                serverRecord: {
                  id: operation.data.id,
                  version: 4,
                  full_name: 'Current server name',
                  is_deleted: false,
                },
              },
            ],
          });
        },
      });
      const patientId = randomUUID();
      const patientDraft = {
        id: patientId,
        version: 3,
        full_name: 'My preserved draft',
        date_of_birth: '1990-01-01',
        gender: 'other',
        phone: '+15555550100',
        address: 'Patient address',
        emergency_contact_name: '',
        emergency_contact_phone: '',
        emergency_contact_relationship: '',
        allergies: '',
        medical_history: '',
        medications: '',
      };
      await client.db.queueAction('EDIT', 'patients', {
        ...patientDraft,
      });
      const [original] = await client.db.syncQueue.toArray();
      const result = await client.db.syncPendingData();
      assert.equal(result.success, false);
      assert.equal(
        (await client.db.syncQueue.get(original.id)).status,
        'conflict',
      );
      const [conflict] = await client.db.getConflictedOperations();
      assert.equal(conflict.payload.full_name, 'My preserved draft');
      assert.equal(conflict.conflictServer.full_name, 'Current server name');

      await assert.rejects(
        client.db.resolveConflict(original.id, 'invalid'),
        /valid conflict resolution/,
      );
      const resolution = await client.db.resolveConflict(original.id, 'local');
      const [rebased] = await client.db.syncQueue.toArray();
      assert.notEqual(resolution.operationId, original.operationId);
      assert.equal(rebased.operationId, resolution.operationId);
      assert.equal(rebased.payload.version, 4);
      assert.equal(rebased.payload.full_name, 'My preserved draft');
      assert.equal(rebased.status, 'pending');
      assert.equal((await client.db.getConflictedOperations()).length, 0);
    },
  );

  await t.test(
    'queued edits preserve their base snapshot through conflicts and local backup recovery',
    async () => {
      const ownerId = randomUUID();
      const patientId = randomUUID();
      const client = makeSyncClient({
        fetchImpl: async (_url, options) => {
          const [operation] = JSON.parse(options.body);
          return response({
            success: true,
            complete: false,
            processed: 0,
            conflicts: 1,
            skipped: 0,
            results: [
              {
                operationId: operation.operationId,
                status: 'conflict',
                code: 'VERSION_MISMATCH',
                reason: 'The patient changed on the server.',
                serverRecord: {
                  id: patientId,
                  version: 2,
                  full_name: 'Current server name',
                  date_of_birth: '1990-01-01',
                  gender: 'other',
                  phone: '+15555550101',
                  address: 'Server address',
                  emergency_contact_name: '',
                  emergency_contact_phone: '',
                  emergency_contact_relationship: '',
                  allergies: '',
                  medical_history: '',
                  medications: '',
                  is_deleted: false,
                },
              },
            ],
          });
        },
      });
      await client.db.setCurrentUser(ownerId);
      await client.db.addLocalPatient({
        id: patientId,
        version: 1,
        full_name: 'Original name',
        date_of_birth: '1990-01-01',
        gender: 'other',
        phone: '+15555550100',
        address: 'Original address',
        emergency_contact_name: '',
        emergency_contact_phone: '',
        emergency_contact_relationship: '',
        allergies: '',
        medical_history: '',
        medications: '',
        is_deleted: false,
      });
      await client.db.updateLocalPatientAndQueue(
        {
          id: patientId,
          version: 1,
          full_name: 'Local name',
          date_of_birth: '1990-01-01',
          gender: 'other',
          phone: '+15555550102',
          address: 'Original address',
          emergency_contact_name: '',
          emergency_contact_phone: '',
          emergency_contact_relationship: '',
          allergies: '',
          medical_history: '',
          medications: '',
        },
        1,
      );
      const [queued] = await client.db.syncQueue.toArray();
      assert.equal(queued.baseRecord.full_name, 'Original name');
      assert.equal(queued.baseRecord.phone, '+15555550100');

      const result = await client.db.syncPendingData();
      assert.equal(result.conflicts, 1);
      const [conflict] = await client.db.getConflictedOperations();
      assert.equal(conflict.payload.full_name, 'Local name');
      assert.equal(conflict.baseRecord.full_name, 'Original name');
      assert.equal(conflict.conflictServer.full_name, 'Current server name');

      const backup = await client.db.exportOfflineData();
      const restored = makeSyncClient({ online: false });
      await restored.db.setCurrentUser(ownerId);
      await restored.db.importOfflineData(backup);
      const [restoredConflict] = await restored.db.getConflictedOperations();
      assert.equal(restoredConflict.baseRecord.phone, '+15555550100');
      assert.equal(restoredConflict.payload.phone, '+15555550102');
      assert.equal(restoredConflict.conflictServer.phone, '+15555550101');
    },
  );

  await t.test(
    'field conflict resolution retains non-conflicting local edits and requires explicit choices',
    async () => {
      const client = makeSyncClient({ online: false });
      const ownerId = randomUUID();
      const patientId = randomUUID();
      await client.db.setCurrentUser(ownerId);
      await client.db.addLocalPatient({
        id: patientId,
        version: 2,
        full_name: 'Local name',
        date_of_birth: '1990-01-01',
        gender: 'other',
        phone: '+15555550102',
        address: 'Local-only address',
        emergency_contact_name: '',
        emergency_contact_phone: '',
        emergency_contact_relationship: '',
        allergies: '',
        medical_history: '',
        medications: '',
        is_deleted: false,
      });
      await client.db.syncQueue.add({
        operationId: randomUUID(),
        ownerId,
        type: 'EDIT',
        store: 'patients',
        payload: {
          id: patientId,
          version: 1,
          full_name: 'Local name',
          date_of_birth: '1990-01-01',
          gender: 'other',
          phone: '+15555550102',
          address: 'Local-only address',
          emergency_contact_name: '',
          emergency_contact_phone: '',
          emergency_contact_relationship: '',
          allergies: '',
          medical_history: '',
          medications: '',
        },
        baseRecord: {
          id: patientId,
          version: 1,
          full_name: 'Original name',
          date_of_birth: '1990-01-01',
          gender: 'other',
          phone: '+15555550100',
          address: 'Original address',
          emergency_contact_name: '',
          emergency_contact_phone: '',
          emergency_contact_relationship: '',
          allergies: '',
          medical_history: '',
          medications: '',
          is_deleted: false,
        },
        conflictServer: {
          id: patientId,
          version: 2,
          full_name: 'Server name',
          date_of_birth: '1990-01-01',
          gender: 'other',
          phone: '+15555550101',
          address: 'Original address',
          emergency_contact_name: '',
          emergency_contact_phone: '',
          emergency_contact_relationship: '',
          allergies: '',
          medical_history: '',
          medications: '',
          is_deleted: false,
        },
        timestamp: new Date().toISOString(),
        status: 'conflict',
      });
      const [conflict] = await client.db.syncQueue.toArray();
      await assert.rejects(
        client.db.resolveConflict(conflict.id, { fields: {} }),
        /Choose the server or local value for full name/,
      );
      assert.equal(
        (await client.db.syncQueue.get(conflict.id)).status,
        'conflict',
      );
      await client.db.resolveConflict(conflict.id, {
        fields: { full_name: 'local', phone: 'server' },
      });
      const [rebased] = await client.db.syncQueue.toArray();
      assert.equal(rebased.status, 'pending');
      assert.equal(rebased.payload.version, 2);
      assert.equal(rebased.payload.full_name, 'Local name');
      assert.equal(rebased.payload.phone, '+15555550101');
      assert.equal(rebased.payload.address, 'Local-only address');
      assert.equal(rebased.baseRecord.version, 2);
      assert.equal(rebased.conflictServer, null);
    },
  );

  await t.test(
    'a mismatched operation acknowledgement never removes a queued change',
    async () => {
      const client = makeSyncClient({
        fetchImpl: async () =>
          response({
            success: true,
            results: [
              {
                operationId: randomUUID(),
                status: 'applied',
              },
            ],
          }),
      });
      await client.db.queueAction('ADD', 'patients', { id: randomUUID() });
      const [queued] = await client.db.syncQueue.toArray();
      const result = await client.db.syncPendingData();
      assert.equal(result.success, false);
      const [retained] = await client.db.syncQueue.toArray();
      assert.equal(retained.id, queued.id);
      assert.equal(retained.operationId, queued.operationId);
    },
  );

  await t.test(
    'server validation failures remain stored and are not retried as new work',
    async () => {
      let requestCount = 0;
      const client = makeSyncClient({
        fetchImpl: async (_url, options) => {
          requestCount++;
          const [operation] = JSON.parse(options.body);
          return response({
            success: true,
            complete: false,
            results: [
              {
                operationId: operation.operationId,
                status: 'failed',
                code: 'VALIDATION_FAILED',
                reason: 'Enter a valid date of birth.',
              },
            ],
          });
        },
      });
      await client.db.queueAction('ADD', 'patients', {
        id: randomUUID(),
        full_name: 'Synthetic invalid patient',
      });
      const first = await client.db.syncPendingData();
      assert.equal(first.success, false);
      const [failed] = await client.db.syncQueue.toArray();
      assert.equal(failed.status, 'failed');
      assert.equal(failed.retryable, false);
      const [failureDetails] = await client.db.getFailedOperations();
      assert.match(failureDetails.lastError, /valid date of birth/);

      await client.db.syncPendingData({ forceRetry: true });
      assert.equal(requestCount, 1);
      assert.equal(await client.db.syncQueue.count(), 1);
    },
  );

  await t.test(
    'server duplicate suggestions retain an offline add until the user explicitly acknowledges matches',
    async () => {
      let requestCount = 0;
      const matchId = randomUUID();
      const client = makeSyncClient({
        fetchImpl: async (_url, options) => {
          requestCount++;
          const [operation] = JSON.parse(options.body);
          if (requestCount === 1) {
            return response({
              success: true,
              complete: false,
              results: [{
                operationId: operation.operationId,
                status: 'failed',
                code: 'POTENTIAL_DUPLICATE',
                reason: 'Possible matching patient records require review.',
                matches: [{
                  id: matchId,
                  full_name: 'Synthetic existing patient',
                  reasons: ['phone'],
                }],
              }],
            });
          }
          assert.equal(operation.data.allowPotentialDuplicates, true);
          assert.deepEqual(operation.data.duplicateAcknowledgedIds, [matchId]);
          return response(acknowledgedOperations(options));
        },
      });
      const patientId = randomUUID();
      await client.db.addLocalPatientAndQueue(
        {
          id: patientId,
          full_name: 'Synthetic queued patient',
          date_of_birth: '1990-01-02',
          gender: 'other',
          phone: '+15555550123',
          address: 'Synthetic address',
        },
        randomUUID(),
      );

      const firstResult = await client.db.syncPendingData();
      assert.equal(firstResult.success, false);
      const [failed] = await client.db.getFailedOperations();
      assert.equal(failed.failureCode, 'POTENTIAL_DUPLICATE');
      assert.equal(failed.duplicateMatches[0].id, matchId);
      assert.equal((await client.db.getPatients()).length, 1);
      assert.equal(await client.db.syncQueue.count(), 1);

      await client.db.continueFailedPatientAdd(failed.id, [matchId]);
      assert.equal((await client.db.syncQueue.get(failed.id)).status, 'pending');
      const secondResult = await client.db.syncPendingData({ forceRetry: true });
      assert.equal(secondResult.success, true);
      assert.equal(await client.db.syncQueue.count(), 0);
      assert.equal((await client.db.getPatients())[0].id, patientId);
    },
  );

  await t.test(
    'acknowledgements match by stable operation ID, not response array position',
    async () => {
      const client = makeSyncClient({
        fetchImpl: async (_url, options) => {
          const operations = JSON.parse(options.body);
          return response({
            success: true,
            complete: true,
            resolvedIndexes: [],
            results: operations
              .slice()
              .reverse()
              .map((operation) => ({
                operationId: operation.operationId,
                status: 'applied',
                serverRecord: { id: operation.data.id, version: 1 },
              })),
          });
        },
      });
      await client.db.queueAction('ADD', 'patients', { id: randomUUID() });
      await client.db.queueAction('ADD', 'patients', { id: randomUUID() });
      const result = await client.db.syncPendingData();
      assert.equal(result.success, true);
      assert.equal(result.processed, 2);
      assert.equal(await client.db.syncQueue.count(), 0);
    },
  );

  await t.test(
    'local offline backup restores queued changes without overwriting existing records',
    async () => {
      const ownerId = randomUUID();
      const patientId = randomUUID();
      const existingOperationId = randomUUID();
      const client = makeSyncClient({ online: false });
      await client.db.setCurrentUser(ownerId);
      await client.db.addLocalPatient({
        id: patientId,
        full_name: 'Original local record',
      });
      await client.db.syncQueue.add({
        operationId: existingOperationId,
        ownerId,
        type: 'EDIT',
        store: 'patients',
        payload: { id: patientId, full_name: 'Original local record' },
        timestamp: new Date().toISOString(),
        status: 'conflict',
        conflictCode: 'VERSION_MISMATCH',
        conflictServer: {
          id: patientId,
          full_name: 'Current server record',
          version: 2,
        },
        lastError: 'Synthetic conflict',
      });
      const backup = await client.db.exportOfflineData();
      backup.patients[0].full_name = 'Do not overwrite';
      backup.pendingOperations.push({
        operationId: randomUUID(),
        type: 'ADD',
        store: 'patients',
        payload: { id: randomUUID(), full_name: 'Restored synthetic patient' },
        timestamp: new Date().toISOString(),
        status: 'pending',
      });

      const restored = makeSyncClient({ online: false });
      await restored.db.setCurrentUser(ownerId);
      await restored.db.addLocalPatient({
        id: patientId,
        full_name: 'Keep existing record',
      });
      const result = await restored.db.importOfflineData(backup);
      assert.equal(result.importedPatients, 0);
      assert.equal(result.importedOperations, 2);
      assert.equal(
        (await restored.db.getPatient(patientId)).full_name,
        'Keep existing record',
      );
      assert.equal(await restored.db.syncQueue.count(), 2);
      assert.equal(
        (await restored.db.syncQueue.toArray()).every(
          (action) => action.ownerId === ownerId,
        ),
        true,
      );
      const [conflict] = await restored.db.getConflictedOperations();
      assert.equal(conflict.payload.full_name, 'Original local record');
      assert.equal(conflict.conflictServer.full_name, 'Current server record');
    },
  );

  await t.test(
    'local offline backups cannot be restored to another account',
    async () => {
      const client = makeSyncClient({ online: false });
      await client.db.setCurrentUser(randomUUID());
      const backup = await client.db.exportOfflineData();
      backup.ownerId = randomUUID();
      await assert.rejects(
        client.db.importOfflineData(backup),
        /invalid, too large, or belongs to another account/,
      );
      assert.equal(await client.db.syncQueue.count(), 0);
    },
  );

  await t.test(
    'malformed conflict baselines reject backup import without altering local queues',
    async () => {
      const ownerId = randomUUID();
      const patientId = randomUUID();
      const source = makeSyncClient({ online: false });
      await source.db.setCurrentUser(ownerId);
      await source.db.syncQueue.add({
        operationId: randomUUID(),
        ownerId,
        type: 'EDIT',
        store: 'patients',
        payload: {
          id: patientId,
          version: 1,
          full_name: 'Synthetic patient',
        },
        baseRecord: {
          id: patientId,
          version: 1,
          full_name: 'Original patient',
        },
        timestamp: new Date().toISOString(),
        status: 'conflict',
      });
      const backup = await source.db.exportOfflineData();
      backup.pendingOperations[0].baseRecord.version = 'not-a-version';

      const destination = makeSyncClient({ online: false });
      await destination.db.setCurrentUser(ownerId);
      const existingId = randomUUID();
      await destination.db.queueAction('ADD', 'patients', {
        id: existingId,
        full_name: 'Existing queued patient',
      });
      const existingQueue = await destination.db.syncQueue.toArray();
      await assert.rejects(
        destination.db.importOfflineData(backup),
        /invalid conflict snapshot/,
      );
      assert.deepEqual(
        await destination.db.syncQueue.toArray(),
        existingQueue,
      );
    },
  );

  await t.test(
    'offline backups redact unsupported legacy operation payloads',
    async () => {
      const client = makeSyncClient({ online: false });
      const ownerId = randomUUID();
      await client.db.setCurrentUser(ownerId);
      await client.db.syncQueue.add({
        operationId: randomUUID(),
        ownerId,
        type: 'ADD',
        store: 'users',
        payload: {
          username: 'synthetic-user',
          password: 'SyntheticNotASecret123!',
        },
        timestamp: new Date().toISOString(),
        status: 'failed',
      });
      const backup = await client.db.exportOfflineData();
      assert.equal(
        JSON.stringify(backup).includes('SyntheticNotASecret123!'),
        false,
      );
      assert.equal(backup.pendingOperations[0].reviewOnly, true);

      const restored = makeSyncClient({ online: false });
      await restored.db.setCurrentUser(ownerId);
      await restored.db.importOfflineData(backup);
      const [operation] = await restored.db.syncQueue.toArray();
      assert.equal(operation.store, 'users');
      assert.equal(Object.keys(operation.payload).length, 0);
      assert.equal(operation.status, 'failed');
    },
  );

  await t.test(
    'IndexedDB initialization failure is surfaced without clearing local stores',
    async () => {
      const client = makeSyncClient({ dbOpenFailure: true });
      assert.equal(await client.db.databaseReady(), false);
      assert.match(
        client.window.healthsysDBError || '',
        /Local patient storage/,
      );
      assert.equal(await client.db.syncQueue.count(), 0);
    },
  );
});
