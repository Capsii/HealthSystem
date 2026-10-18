// public/js/db.js
// Dexie IndexedDB setup for Healthcare PWA
const db = window.healthsysDB || new Dexie('healthsysDB');
window.healthsysDB = db;
const LOCAL_BACKUP_FORMAT = 'healthsys-local-offline-backup';
const LOCAL_BACKUP_VERSION = 1;
const PATIENT_SNAPSHOT_FIELDS = [
  'id',
  'full_name',
  'date_of_birth',
  'gender',
  'phone',
  'address',
  'emergency_contact_name',
  'emergency_contact_phone',
  'emergency_contact_relationship',
  'allergies',
  'medical_history',
  'medications',
  'is_deleted',
  'version',
  'created_at',
  'updated_at',
  'last_modified_by',
];
const PATIENT_SYNC_FIELDS = [
  'full_name',
  'date_of_birth',
  'gender',
  'phone',
  'address',
  'emergency_contact_name',
  'emergency_contact_phone',
  'emergency_contact_relationship',
  'allergies',
  'medical_history',
  'medications',
];

function isPatientId(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

db.version(1).stores({
  patients: 'id, full_name, date_of_birth, gender, phone, address',
  syncQueue: '++id, type, store, payload, timestamp',
});

db.version(2).stores({
  patients: 'id, full_name, date_of_birth, gender, phone, address',
  syncQueue: '++id, type, store, payload, timestamp, status',
});

db.version(3).stores({
  patients: 'id, full_name, date_of_birth, gender, phone, address',
  syncQueue: '++id, type, store, payload, timestamp, status',
  dashboardMetrics: 'id',
});

db.version(4)
  .stores({
    patients: 'id, full_name, date_of_birth, gender, phone, address',
    syncQueue: '++id, type, store, payload, timestamp, status',
    dashboardMetrics: 'id',
  })
  .upgrade((transaction) =>
    transaction
      .table('syncQueue')
      .where('store')
      .equals('users')
      .modify((action) => {
        action.status = 'failed';
        action.lastError =
          'This legacy queued change is preserved but is not supported for synchronization.';
        action.payload = {};
      }),
  );

db.version(5)
  .stores({
    patients: 'id, ownerId, full_name, date_of_birth, gender, phone, address',
    syncQueue:
      '++id, type, store, payload, timestamp, status, ownerId, operationId',
    dashboardMetrics: 'id',
  })
  .upgrade((transaction) =>
    transaction
      .table('syncQueue')
      .toCollection()
      .modify((action) => {
        if (action.store === 'patients' && !action.ownerId) {
          action.ownerId = 'unassigned';
          action.status = 'failed';
          action.lastError =
            'This queued change predates account isolation and requires administrator review.';
        }
      }),
  );

db.version(6)
  .stores({
    patients: 'id, ownerId, full_name, date_of_birth, gender, phone, address',
    syncQueue:
      '++id, type, store, payload, timestamp, status, ownerId, operationId',
    dashboardMetrics: 'id',
  })
  .upgrade((transaction) =>
    transaction
      .table('syncQueue')
      .toCollection()
      .modify((action) => {
        if (
          action.store !== 'patients' ||
          !['ADD', 'EDIT', 'DELETE'].includes(action.type)
        ) {
          action.status = 'failed';
          action.lastError =
            'This queued change is unsupported and was preserved for review.';
          if (action.store !== 'patients') action.payload = {};
        }
      }),
  );

db.version(7)
  .stores({
    patients: 'id, ownerId, full_name, date_of_birth, gender, phone, address',
    syncQueue:
      '++id, type, store, payload, timestamp, status, ownerId, operationId',
    dashboardMetrics: 'id',
  })
  .upgrade((transaction) =>
    transaction
      .table('syncQueue')
      .toCollection()
      .modify((action) => {
        if (
          action.store !== 'patients' ||
          !['ADD', 'EDIT', 'DELETE'].includes(action.type)
        )
          return;
        if (
          !['pending', 'inProgress', 'failed', 'conflict'].includes(
            action.status,
          )
        ) {
          action.status = 'pending';
        }
        if (
          !Number.isSafeInteger(action.attemptCount) ||
          action.attemptCount < 0
        ) {
          action.attemptCount = 0;
        }
        if (typeof action.retryable !== 'boolean') {
          action.retryable =
            action.status === 'failed' || action.status === 'inProgress';
        }
      }),
  );

function repairLegacyPatientPrimaryKey(databaseName) {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  const recoveryStoreName = '__healthsys_patients_pk_recovery';
  return new Promise((resolve, reject) => {
    const inspectRequest = indexedDB.open(databaseName);
    inspectRequest.onerror = () =>
      reject(inspectRequest.error || new Error('IndexedDB inspection failed.'));
    inspectRequest.onblocked = () =>
      reject(new Error('IndexedDB inspection is blocked by another page.'));
    inspectRequest.onsuccess = () => {
      const database = inspectRequest.result;
      if (!database.objectStoreNames.contains('patients')) {
        database.close();
        resolve();
        return;
      }

      const inspection = database.transaction('patients', 'readonly');
      const patients = inspection.objectStore('patients');
      const requiresRepair =
        patients.keyPath === 'id' && patients.autoIncrement;
      if (!requiresRepair) {
        database.close();
        resolve();
        return;
      }
      if (database.objectStoreNames.contains(recoveryStoreName)) {
        database.close();
        reject(
          new Error(
            'An earlier patient-store recovery is present and requires administrator review.',
          ),
        );
        return;
      }

      const indexDefinitions = Array.from(patients.indexNames, (name) => {
        const index = patients.index(name);
        return {
          name,
          keyPath: index.keyPath,
          unique: index.unique,
          multiEntry: index.multiEntry,
        };
      });
      const nextVersion = database.version + 1;
      database.close();

      const upgradeRequest = indexedDB.open(databaseName, nextVersion);
      upgradeRequest.onerror = () =>
        reject(
          upgradeRequest.error ||
            new Error('Patient-store recovery could not be completed.'),
        );
      upgradeRequest.onblocked = () => {
        console.warn(
          '[DB] Patient-store recovery is waiting for other HealthSys pages to close.',
        );
      };
      upgradeRequest.onupgradeneeded = () => {
        const upgradedDatabase = upgradeRequest.result;
        const transaction = upgradeRequest.transaction;
        const legacyPatients = transaction.objectStore('patients');
        const recoveryStore = upgradedDatabase.createObjectStore(
          recoveryStoreName,
          { keyPath: 'id', autoIncrement: true },
        );
        const copyToRecovery = legacyPatients.openCursor();
        copyToRecovery.onerror = () => transaction.abort();
        copyToRecovery.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            recoveryStore.add(cursor.value);
            cursor.continue();
            return;
          }

          upgradedDatabase.deleteObjectStore('patients');
          const patientsStore = upgradedDatabase.createObjectStore('patients', {
            keyPath: 'id',
          });
          for (const definition of indexDefinitions) {
            patientsStore.createIndex(definition.name, definition.keyPath, {
              unique: definition.unique,
              multiEntry: definition.multiEntry,
            });
          }

          const restoreCursor = recoveryStore.openCursor();
          restoreCursor.onerror = () => transaction.abort();
          restoreCursor.onsuccess = (restoreEvent) => {
            const recoveryCursor = restoreEvent.target.result;
            if (recoveryCursor) {
              patientsStore.add(recoveryCursor.value);
              recoveryCursor.continue();
              return;
            }
            upgradedDatabase.deleteObjectStore(recoveryStoreName);
          };
        };
      };
      upgradeRequest.onsuccess = () => {
        upgradeRequest.result.close();
        resolve();
      };
    };
  });
}

let databaseOpening = true;
window.healthsysDBError = null;
window.healthsysDBReady = Promise.resolve()
  .then(() => repairLegacyPatientPrimaryKey(db.name))
  .then(() => db.open())
  .then(() => true)
  .catch((error) => {
    window.healthsysDBError =
      'Local patient storage could not be opened. Do not clear browser data or reinstall the app; pending changes may still be recoverable.';
    console.error(
      '[DB] IndexedDB initialization failed:',
      error?.name || 'DATABASE_ERROR',
      error?.message || '',
      error?.inner?.name || error?.inner?.message || '',
    );
    window.dispatchEvent(new CustomEvent('healthsys:database-error'));
    return false;
  })
  .finally(() => {
    databaseOpening = false;
  });

let syncPromise = null;
let localWriteCount = 0;
async function withLocalWrite(callback) {
  localWriteCount++;
  try {
    return await callback();
  } finally {
    localWriteCount--;
  }
}
const syncChannel =
  typeof BroadcastChannel === 'function'
    ? new BroadcastChannel('healthsys-sync-queue')
    : null;

function dispatchQueueChanged() {
  window.dispatchEvent(new CustomEvent('healthsys:queue-changed'));
  if (syncChannel) syncChannel.postMessage('changed');
}

if (syncChannel) {
  syncChannel.addEventListener('message', () => {
    window.dispatchEvent(new CustomEvent('healthsys:queue-changed'));
  });
}

function syncMetadataKey() {
  return 'healthsys:sync';
}

function readSyncMetadata() {
  try {
    return JSON.parse(localStorage.getItem(syncMetadataKey()) || '{}');
  } catch (error) {
    console.error('[SYNC] Could not read persisted sync status:', error);
    return {};
  }
}

function writeSyncMetadata(metadata) {
  try {
    localStorage.setItem(syncMetadataKey(), JSON.stringify(metadata));
  } catch (error) {
    console.error('[SYNC] Could not persist sync status:', error);
  }
}

function updateSyncMetadata(update) {
  const metadata = {
    ...readSyncMetadata(),
    ...update,
    ownerId: window.db?.userId || null,
  };
  writeSyncMetadata(metadata);
  window.dispatchEvent(
    new CustomEvent('healthsys:sync-state', { detail: metadata }),
  );
  return metadata;
}

async function getQueueStatus() {
  const allActions = await db.syncQueue.toArray();
  const actions = allActions.filter(
    (action) => action && action.ownerId === window.db.userId,
  );
  const reviewRequired = allActions.filter(
    (action) => action && action.ownerId === 'unassigned',
  );
  return {
    total: actions.length,
    pending: actions.filter((action) => action.status === 'pending').length,
    processing: actions.filter((action) => action.status === 'inProgress')
      .length,
    failed:
      actions.filter((action) => action.status === 'failed').length +
      reviewRequired.length,
    conflicts: actions.filter((action) => action.status === 'conflict').length,
    reviewRequired: reviewRequired.length,
  };
}

async function getConflictedOperations() {
  return (await db.syncQueue.toArray())
    .filter(
      (action) =>
        action?.ownerId === window.db.userId && action.status === 'conflict',
    )
    .map((action) => ({
      id: action.id,
      operationId: action.operationId,
      type: action.type,
      payload: action.payload,
      baseRecord: action.baseRecord || null,
      conflictServer: action.conflictServer || null,
      conflictCode: action.conflictCode || 'CONFLICT',
      lastError: action.lastError || 'This change needs review.',
    }));
}

async function getFailedOperations() {
  return (await db.syncQueue.toArray())
    .filter(
      (action) =>
        action?.ownerId === window.db.userId && action.status === 'failed',
    )
    .map((action) => ({
      id: action.id,
      operationId: action.operationId,
      type: action.type,
      payload: action.payload,
      patientId: action.payload?.id || null,
      patientName:
        typeof action.payload?.full_name === 'string'
          ? action.payload.full_name
          : null,
      correctable:
        ['ADD', 'EDIT'].includes(action.type) &&
        isPatientId(action.payload?.id),
      retryable: action.retryable === true,
      failureCode: action.failureCode || null,
      duplicateMatches: Array.isArray(action.duplicateMatches)
        ? action.duplicateMatches
        : [],
      nextRetryAt: action.nextRetryAt || null,
      lastError: action.lastError || 'This queued change needs review.',
    }));
}

async function continueFailedPatientAdd(queueId, acknowledgedIds) {
  if (!Number.isSafeInteger(queueId) || !window.db.userId ||
    !Array.isArray(acknowledgedIds) || acknowledgedIds.length > 40 ||
    acknowledgedIds.some((id) => !isPatientId(id))) {
    throw new Error('A valid queued operation and duplicate review are required.');
  }
  await withLocalWrite(() =>
    db.transaction('rw', db.syncQueue, async () => {
      const action = await db.syncQueue.get(queueId);
      if (action?.ownerId !== window.db.userId || action.status !== 'failed' ||
        action.type !== 'ADD' || action.failureCode !== 'POTENTIAL_DUPLICATE') {
        throw new Error('This queued patient addition is not awaiting duplicate review.');
      }
      const updated = await db.syncQueue.update(queueId, {
        payload: {
          ...action.payload,
          allowPotentialDuplicates: true,
          duplicateAcknowledgedIds: [...new Set(acknowledgedIds)],
        },
        status: 'pending',
        retryable: false,
        nextRetryAt: null,
        failureCode: null,
        duplicateMatches: [],
        lastError: null,
        correctedAt: new Date().toISOString(),
      });
      if (updated !== 1) {
        throw new Error('The queued patient addition changed before review was saved.');
      }
    }),
  );
  dispatchQueueChanged();
}

async function correctFailedOperation(queueId, values) {
  if (!Number.isSafeInteger(queueId) || !window.db.userId) {
    throw new Error('A valid queued operation and signed-in account are required.');
  }
  const normalized = normalizeQueuedPatient(values);
  let operationId;
  await withLocalWrite(() =>
    db.transaction('rw', db.patients, db.syncQueue, async () => {
      const action = await db.syncQueue.get(queueId);
      if (
        action?.ownerId !== window.db.userId ||
        action.status !== 'failed' ||
        !['ADD', 'EDIT'].includes(action.type) ||
        !isPatientId(action.payload?.id)
      ) {
        throw new Error('This failed patient operation cannot be corrected here.');
      }
      if (action.type === 'EDIT' &&
        (!Number.isSafeInteger(Number(action.payload.version)) ||
          Number(action.payload.version) < 1)
      ) {
        throw new Error('The queued edit has no valid record version; preserve it and resolve the conflict instead.');
      }
      const payload = {
        id: action.payload.id,
        ...(action.type === 'EDIT' ? { version: Number(action.payload.version) } : {}),
        ...normalized,
      };
      const updated = await db.syncQueue.update(queueId, {
        payload,
        status: 'pending',
        retryable: false,
        nextRetryAt: null,
        lastError: null,
        correctedAt: new Date().toISOString(),
      });
      if (updated !== 1) {
        throw new Error('The queued operation changed before the correction was saved.');
      }
      const current = await db.patients.get(payload.id);
      if (current?.ownerId === window.db.userId) {
        await db.patients.put({
          ...current,
          ...normalized,
          pendingSync: true,
          ownerId: window.db.userId,
        });
      }
      operationId = action.operationId;
    }),
  );
  dispatchQueueChanged();
  return { operationId };
}

function normalizeQueuedPatient(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('Enter valid patient details.');
  }
  const fields = [
    'full_name',
    'date_of_birth',
    'gender',
    'phone',
    'address',
    'emergency_contact_name',
    'emergency_contact_phone',
    'emergency_contact_relationship',
    'allergies',
    'medical_history',
    'medications',
  ];
  const data = {};
  for (const field of fields) {
    if (values[field] !== undefined && typeof values[field] !== 'string') {
      throw new Error(`Enter valid text for ${field.replaceAll('_', ' ')}.`);
    }
    data[field] = typeof values[field] === 'string' ? values[field].trim() : '';
  }
  if (!data.full_name || data.full_name.length > 255) {
    throw new Error('Enter a patient name up to 255 characters.');
  }
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data.date_of_birth);
  if (!dateMatch) throw new Error('Enter a valid date of birth.');
  const [year, month, day] = dateMatch.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date > new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)
  ) {
    throw new Error('Enter a real date of birth that is not in the future.');
  }
  if (!['male', 'female', 'other'].includes(data.gender.toLowerCase())) {
    throw new Error('Select a valid gender.');
  }
  const normalizePhone = (value) => {
    let normalized = value.trim().replace(/[().\-\s]/g, '');
    if (normalized.startsWith('00')) normalized = `+${normalized.slice(2)}`;
    const digits = normalized.startsWith('+') ? normalized.slice(1) : normalized;
    return /^\d{7,15}$/.test(digits) ? normalized : null;
  };
  data.phone = normalizePhone(data.phone);
  if (!data.phone) throw new Error('Enter a valid phone number with 7 to 15 digits.');
  if (!data.address || data.address.length > 2000) {
    throw new Error('Enter an address up to 2,000 characters.');
  }
  if (data.emergency_contact_phone) {
    data.emergency_contact_phone = normalizePhone(data.emergency_contact_phone);
    if (!data.emergency_contact_phone) {
      throw new Error('Enter a valid emergency contact phone number.');
    }
  }
  const limits = {
    emergency_contact_name: 255,
    emergency_contact_phone: 30,
    emergency_contact_relationship: 100,
    allergies: 10000,
    medical_history: 10000,
    medications: 10000,
  };
  for (const [field, maximum] of Object.entries(limits)) {
    if (data[field].length > maximum) {
      throw new Error(`Patient field ${field.replaceAll('_', ' ')} exceeds ${maximum} characters.`);
    }
  }
  return data;
}

async function updateLocalPatientAndQueue(patient, expectedVersion) {
  if (!isPatientId(patient?.id) || !window.db.userId) {
    throw new Error('A valid patient and signed-in account are required.');
  }
  if (!Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 1) {
    throw new Error('A valid patient version is required to edit this record.');
  }
  const normalized = normalizeQueuedPatient(patient);
  let operationId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  await withLocalWrite(() =>
    db.transaction('rw', db.patients, db.syncQueue, async () => {
      const current = await db.patients.get(patient.id);
      if (current?.ownerId !== window.db.userId || current.is_deleted) {
        throw new Error('This patient is not available for editing on this device.');
      }
      if (Number(current.version) !== Number(expectedVersion)) {
        throw new Error(
          'This local patient changed while the edit was open. Reload it and review the latest local version.',
        );
      }
      await db.patients.put({
        ...current,
        ...normalized,
        ownerId: window.db.userId,
        pendingSync: true,
        updated_at: timestamp,
      });
      const queuedActions = await db.syncQueue.toArray();
      const pending = queuedActions
        .filter(
          (action) =>
            action?.ownerId === window.db.userId &&
            action.store === 'patients' &&
            ['ADD', 'EDIT'].includes(action.type) &&
            action.payload?.id === patient.id &&
            action.status === 'pending' &&
            Number(action.attemptCount || 0) === 0,
        )
        .sort((left, right) => right.id - left.id)[0];
      const earlierBase = queuedActions
        .filter(
          (action) =>
            action?.ownerId === window.db.userId &&
            action.store === 'patients' &&
            action.payload?.id === patient.id &&
            Number(action.payload?.version) === Number(expectedVersion) &&
            action.baseRecord,
        )
        .sort((left, right) => left.id - right.id)[0]?.baseRecord;
      const baseRecord =
        pending?.baseRecord ||
        earlierBase ||
        (current.pendingSync ? null : snapshotPatientForConflict(current));
      if (pending) {
        const pendingBaseRecord =
          pending.type === 'EDIT' ? baseRecord : null;
        const updated = await db.syncQueue.update(pending.id, {
          payload: { ...pending.payload, ...normalized },
          ...(pendingBaseRecord ? { baseRecord: pendingBaseRecord } : {}),
          timestamp,
        });
        if (updated !== 1) {
          throw new Error(
            'The queued patient edit changed before the local update was saved.',
          );
        }
        operationId = pending.operationId;
        return;
      }
      await db.syncQueue.add({
        operationId,
        ownerId: window.db.userId,
        type: 'EDIT',
        store: 'patients',
        payload: { id: patient.id, version: Number(expectedVersion), ...normalized },
        baseRecord,
        timestamp,
        status: 'pending',
        attemptCount: 0,
        retryable: false,
      });
    }),
  );
  dispatchQueueChanged();
  return { operationId };
}

function snapshotPatientForConflict(patient) {
  if (!patient || !isPatientId(patient.id)) return null;
  return Object.fromEntries(
    ['id', 'version', ...PATIENT_SYNC_FIELDS, 'is_deleted'].flatMap((field) =>
      patient[field] === undefined ? [] : [[field, patient[field]]],
    ),
  );
}

async function resolveConflict(queueId, resolution) {
  const wholeRecordChoice =
    resolution === 'server' || resolution === 'local' ? resolution : null;
  const fieldChoices =
    resolution && typeof resolution === 'object' && !Array.isArray(resolution)
      ? resolution.fields
      : null;
  if (
    !Number.isSafeInteger(queueId) ||
    (!wholeRecordChoice &&
      (!fieldChoices ||
        typeof fieldChoices !== 'object' ||
        Array.isArray(fieldChoices) ||
        Object.values(fieldChoices).some(
          (choice) => choice !== 'server' && choice !== 'local',
        )))
  ) {
    throw new Error('Choose a valid conflict resolution.');
  }
  if (!window.db.userId)
    throw new Error('Sign in to resolve queued patient changes.');

  let resolved;
  await withLocalWrite(() =>
    db.transaction('rw', db.patients, db.syncQueue, async () => {
      const action = await db.syncQueue.get(queueId);
      if (
        action?.ownerId !== window.db.userId ||
        action.status !== 'conflict'
      ) {
        throw new Error('This conflict is no longer available.');
      }
      const serverRecord = action.conflictServer;
      if (wholeRecordChoice === 'server') {
        if (serverRecord) {
          await db.patients.put({ ...serverRecord, ownerId: window.db.userId });
        } else {
          await db.patients.delete(action.payload?.id);
        }
        await db.syncQueue.delete(queueId);
        resolved = {
          choice: 'server',
          patientId: action.payload?.id,
        };
        return;
      }

      if (
        !serverRecord ||
        serverRecord.is_deleted ||
        action.type === 'ADD'
      ) {
        throw new Error(
          'This change cannot be kept over the current server record.',
        );
      }
      const serverVersion = Number(serverRecord.version);
      if (!Number.isSafeInteger(serverVersion) || serverVersion < 1) {
        throw new Error(
          'The current server version is unavailable; both records remain preserved.',
        );
      }

      const operationId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      let payload;
      if (action.type === 'DELETE') {
        if (wholeRecordChoice !== 'local') {
          throw new Error('Choose whether to keep or discard the queued deletion.');
        }
        payload = { id: action.payload.id, version: serverVersion };
      } else if (wholeRecordChoice === 'local') {
        const normalized = normalizeQueuedPatient(action.payload);
        payload = {
          ...normalized,
          id: action.payload.id,
          version: serverVersion,
        };
      } else if (fieldChoices) {
        const baseRecord = action.baseRecord;
        const localValues = normalizeQueuedPatient(action.payload);
        if (
          baseRecord &&
          (baseRecord.id !== action.payload.id ||
            !Number.isSafeInteger(Number(baseRecord.version)) ||
            Number(baseRecord.version) < 1 ||
            PATIENT_SYNC_FIELDS.some(
              (field) =>
                baseRecord[field] !== undefined &&
                typeof baseRecord[field] !== 'string',
            ))
        ) {
          throw new Error(
            'The original patient version is invalid; both records remain preserved.',
          );
        }
        const values = Object.fromEntries(
          PATIENT_SYNC_FIELDS.map((field) => [
            field,
            typeof serverRecord[field] === 'string'
              ? serverRecord[field]
              : '',
          ]),
        );
        for (const field of PATIENT_SYNC_FIELDS) {
          const localValue = localValues[field];
          const serverValue = values[field];
          const baseValue =
            typeof baseRecord?.[field] === 'string'
              ? baseRecord[field]
              : null;
          const localChanged = baseValue === null || localValue !== baseValue;
          const serverChanged =
            baseValue === null || serverValue !== baseValue;
          const conflicting =
            localValue !== serverValue && localChanged && serverChanged;
          if (conflicting && !fieldChoices[field]) {
            throw new Error(
              `Choose the server or local value for ${field.replaceAll('_', ' ')}.`,
            );
          }
          if (fieldChoices[field] === 'local') {
            values[field] = localValue;
          } else if (
            fieldChoices[field] !== 'server' &&
            localChanged &&
            !serverChanged
          ) {
            values[field] = localValue;
          }
        }
        const normalized = normalizeQueuedPatient(values);
        payload = {
          ...normalized,
          id: action.payload.id,
          version: serverVersion,
        };
      } else {
        throw new Error('Choose a valid conflict resolution.');
      }
      const original = Object.fromEntries(
        Object.entries(action).filter(([key]) => key !== 'id'),
      );
      await db.syncQueue.add({
        ...original,
        operationId,
        payload,
        timestamp,
        status: 'pending',
        baseRecord: snapshotPatientForConflict(serverRecord),
        attemptCount: 0,
        retryable: false,
        lastAttemptAt: null,
        nextRetryAt: null,
        lastError: null,
        conflictServer: null,
        conflictCode: null,
        resolvedFromOperationId: action.operationId,
      });
      if (action.type === 'DELETE') {
        await db.patients.put({
          ...serverRecord,
          ownerId: window.db.userId,
          is_deleted: true,
          pendingSyncDelete: true,
        });
      } else {
        await db.patients.put({
          ...serverRecord,
          ...payload,
          ownerId: window.db.userId,
          pendingSync: true,
        });
      }
      await db.syncQueue.delete(queueId);
      resolved = {
        choice: wholeRecordChoice || 'fields',
        operationId,
        patientId: action.payload.id,
      };
    }),
  );
  dispatchQueueChanged();
  return resolved;
}

async function recoverInterruptedSync() {
  const recover = async (lockHeld = false) => {
    const now = Date.now();
    const interrupted = await db.syncQueue
      .where('status')
      .equals('inProgress')
      .toArray();
    for (const action of interrupted) {
      if (!action) continue;
      const startedAt = Date.parse(action.syncStartedAt || '');
      if (!lockHeld && Number.isFinite(startedAt) && now - startedAt < 120000)
        continue;
      await updateQueuedAction(action, {
        status: 'failed',
        retryable: true,
        nextRetryAt: null,
        lastError:
          'Previous synchronization was interrupted. Retry when online.',
      });
    }

    const metadata = readSyncMetadata();
    const queue = await db.syncQueue.toArray();
    const attemptAt = Date.parse(metadata.lastAttemptAt || '');
    if (
      metadata.lastOutcome === 'In Progress' &&
      !queue.some((action) => action?.status === 'inProgress') &&
      (!Number.isFinite(attemptAt) || now - attemptAt >= 120000)
    ) {
      updateSyncMetadata({
        lastOutcome: 'Failure',
        lastError:
          'The previous synchronization did not finish. Queued changes are retained.',
      });
    }
  };

  if (navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request('healthsys-sync-queue', () => recover(true));
  }
  return recover();
}

async function saveDashboardMetrics(metrics) {
  await withLocalWrite(() =>
    db.dashboardMetrics.put({
      id: 'server',
      ownerId: window.db.userId,
      metrics,
      savedAt: new Date().toISOString(),
    }),
  );
}

async function getDashboardMetrics() {
  const snapshot = await db.dashboardMetrics.get('server');
  return snapshot?.ownerId === window.db.userId ? snapshot : null;
}

// =============================
// 📥 PATIENT STORAGE
// =============================
async function savePatients(patients) {
  return withLocalWrite(async () => {
    const pendingActions = (await db.syncQueue.toArray()).filter(
      (action) => action && action.ownerId === window.db.userId,
    );

    const pendingIds = new Set();

    pendingActions.forEach((action) => {
      if (!action.payload) return;

      if (action.type === 'ADD' || action.type === 'EDIT') {
        pendingIds.add(action.payload.id);
      }

      if (action.type === 'DELETE') {
        pendingIds.add(action.payload.id);
      }
    });

    const existingPatients = (await db.patients.toArray()).filter(
      (patient) => patient.ownerId === window.db.userId,
    );

    // Remove server records that are no longer on server but preserve pending changes.
    for (const patient of existingPatients) {
      if (
        !patients.some((serverPatient) => serverPatient.id === patient.id) &&
        !pendingIds.has(patient.id)
      ) {
        await db.patients.delete(patient.id);
      }
    }

    for (const patient of patients) {
      if (!pendingIds.has(patient.id)) {
        await db.patients.put({ ...patient, ownerId: window.db.userId });
      }
    }
  });
}

async function getPatients() {
  return (await db.patients.toArray()).filter(
    (patient) => patient.ownerId === window.db.userId,
  );
}

async function getPatient(id) {
  const patient = await db.patients.get(id);
  return patient?.ownerId === window.db.userId ? patient : undefined;
}

async function addLocalPatient(patient) {
  if (!patient || !isPatientId(patient.id))
    throw new Error('A valid patient UUID is required.');
  await withLocalWrite(() =>
    db.patients.add({ ...patient, ownerId: window.db.userId }),
  );
}

async function addLocalPatientAndQueue(
  patient,
  operationId = crypto.randomUUID(),
) {
  if (!patient || !isPatientId(patient.id))
    throw new Error('A valid patient UUID is required.');
  if (!isPatientId(operationId))
    throw new Error('A valid operation UUID is required.');
  const action = {
    operationId,
    ownerId: window.db.userId,
    type: 'ADD',
    store: 'patients',
    payload: { ...patient, ownerId: window.db.userId },
    timestamp: new Date().toISOString(),
    status: 'pending',
    attemptCount: 0,
    retryable: false,
  };
  await withLocalWrite(() =>
    db.transaction('rw', db.patients, db.syncQueue, async () => {
      await db.patients.add({ ...patient, ownerId: window.db.userId });
      await db.syncQueue.add(action);
    }),
  );
  dispatchQueueChanged();
}

async function updateLocalPatient(patient) {
  if (!patient || !isPatientId(patient.id))
    throw new Error('A valid patient UUID is required.');
  await withLocalWrite(() =>
    db.patients.put({ ...patient, ownerId: window.db.userId }),
  );
}

async function deleteLocalPatient(id) {
  await withLocalWrite(() => db.patients.delete(id));
}

// =============================
// 🔄 OFFLINE QUEUE SYSTEM
// =============================

async function queueAction(type, store, payload) {
  if (store !== 'patients' || !['ADD', 'EDIT', 'DELETE'].includes(type)) {
    throw new Error('Only supported patient operations can be queued.');
  }
  if (!isPatientId(payload?.id) || !window.db.userId) {
    throw new Error('A valid patient and authenticated account are required.');
  }
  await withLocalWrite(() =>
    db.syncQueue.add({
      operationId: crypto.randomUUID(),
      ownerId: window.db.userId,
      type,
      store,
      payload,
      timestamp: new Date().toISOString(),
      status: 'pending',
      attemptCount: 0,
      retryable: false,
    }),
  );
  dispatchQueueChanged();
}

async function queuePatientDeletion(
  id,
  version,
  operationId = crypto.randomUUID(),
) {
  if (!isPatientId(id) || !isPatientId(operationId)) {
    throw new Error('Valid patient and operation UUIDs are required.');
  }
  if (
    !Number.isSafeInteger(Number(version)) ||
    Number(version) < 1 ||
    !window.db.userId
  ) {
    throw new Error(
      'A valid patient version and authenticated account are required.',
    );
  }
  const action = {
    operationId,
    ownerId: window.db.userId,
    type: 'DELETE',
    store: 'patients',
    payload: { id, version },
    timestamp: new Date().toISOString(),
    status: 'pending',
  };
  await withLocalWrite(() =>
    db.transaction('rw', db.patients, db.syncQueue, async () => {
      await db.syncQueue.add(action);
      await db.patients.update(id, {
        is_deleted: true,
        pendingSyncDelete: true,
      });
    }),
  );
  dispatchQueueChanged();
}

// =============================
// 🌐 SYNC FUNCTION
// =============================

async function syncPendingData({ forceRetry = false } = {}) {
  if (syncPromise) return syncPromise;

  const execute = () => runSync({ forceRetry });
  syncPromise =
    navigator.locks && typeof navigator.locks.request === 'function'
      ? navigator.locks.request('healthsys-sync-queue', execute)
      : execute();
  try {
    return await syncPromise;
  } finally {
    syncPromise = null;
  }
}

async function runSync({ forceRetry = false } = {}) {
  let actions = [];
  let invalidActions = [];
  if (!(await window.healthsysDBReady)) {
    const error =
      window.healthsysDBError ||
      'Local patient storage is unavailable. Queued changes were not sent.';
    updateSyncMetadata({
      lastAttemptAt: new Date().toISOString(),
      lastOutcome: 'Failure',
      lastError: error,
    });
    return {
      success: false,
      partial: false,
      processed: 0,
      conflicts: 0,
      error,
    };
  }
  const attemptAt = new Date().toISOString();
  updateSyncMetadata({
    lastAttemptAt: attemptAt,
    lastOutcome: 'In Progress',
    lastError: null,
  });

  try {
    if (!navigator.onLine) {
      const error = 'Synchronization cannot run while this device is offline.';
      updateSyncMetadata({
        lastAttemptAt: new Date().toISOString(),
        lastOutcome: 'Failure',
        lastError: error,
      });
      return {
        success: false,
        partial: false,
        processed: 0,
        conflicts: 0,
        error,
      };
    }

    const now = Date.now();
    const accountQueue = (await db.syncQueue.toArray()).filter(
      (action) => action && action.ownerId === window.db.userId,
    );
    actions = accountQueue
      .filter(
        (action) =>
          action.status === 'pending' ||
          (action.status === 'failed' &&
            (action.retryable === true ||
              (forceRetry && action.retryable !== false)) &&
            (forceRetry ||
              !Number.isFinite(Date.parse(action.nextRetryAt || '')) ||
              Date.parse(action.nextRetryAt) <= now)),
      )
      .slice(0, 500);
    const remainingQueueCount = Math.max(
      0,
      accountQueue.length - actions.length,
    );

    if (actions.length === 0) {
      const hasUnresolved = accountQueue.length > 0;
      updateSyncMetadata({
        lastAttemptAt: new Date().toISOString(),
        lastOutcome: hasUnresolved ? 'Partial Failure' : 'Success',
        lastError: hasUnresolved
          ? 'Queued changes remain in conflict, need review, or are waiting for retry.'
          : null,
      });
      return {
        success: !hasUnresolved,
        partial: hasUnresolved,
        processed: 0,
        conflicts: accountQueue.filter((action) => action.status === 'conflict')
          .length,
        unresolved: accountQueue.length,
        nothingToSync: !hasUnresolved,
        error: hasUnresolved
          ? 'Queued changes remain in conflict, need review, or are waiting for retry.'
          : undefined,
      };
    }

    for (const action of actions) {
      action.attemptCount = (Number(action.attemptCount) || 0) + 1;
      const marked = await updateQueuedAction(action, {
        status: 'inProgress',
        syncStartedAt: attemptAt,
        lastAttemptAt: attemptAt,
        attemptCount: action.attemptCount,
        retryable: false,
        lastError: null,
      });
      if (!marked) {
        throw new Error(
          'A queued change could not be marked for synchronization.',
        );
      }
    }
    dispatchQueueChanged();
    window.dispatchEvent(
      new CustomEvent('healthsys:sync-progress', {
        detail: { completed: 0, total: actions.length },
      }),
    );

    const operations = [];
    const validActions = [];
    for (const action of actions) {
      const payload = action?.payload;
      const validType = ['ADD', 'EDIT', 'DELETE'].includes(action?.type);
      const validPayload =
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        isPatientId(payload.id);
      const validTimestamp =
        typeof action?.timestamp === 'string' &&
        Number.isFinite(Date.parse(action.timestamp));
      const hasInvalidOperationId =
        action?.operationId && !isPatientId(action.operationId);
      let error = null;
      if (
        !Number.isSafeInteger(action?.id) ||
        action.store !== 'patients' ||
        !validType ||
        !validPayload ||
        !validTimestamp ||
        hasInvalidOperationId
      ) {
        error = 'Queued operation is malformed and was retained for review.';
      } else if (
        action.type === 'DELETE' &&
        (!Number.isSafeInteger(Number(payload.version)) ||
          Number(payload.version) < 1)
      ) {
        error =
          'Queued deletion is missing a valid patient version and was retained for review.';
      } else if (
        action.type === 'EDIT' &&
        (!Number.isSafeInteger(Number(payload.version)) ||
          Number(payload.version) < 1)
      ) {
        error =
          'Queued edit is missing a valid patient version and was retained for review.';
      } else if (
        ['ADD', 'EDIT'].includes(action.type) &&
        PATIENT_SYNC_FIELDS.some(
          (field) =>
            payload[field] !== undefined && typeof payload[field] !== 'string',
        )
      ) {
        error =
          'Queued patient fields are malformed and were retained for review.';
      } else if (
        action.type === 'ADD' &&
        payload.allowPotentialDuplicates !== undefined &&
        (payload.allowPotentialDuplicates !== true ||
          !Array.isArray(payload.duplicateAcknowledgedIds) ||
          payload.duplicateAcknowledgedIds.length > 40 ||
          payload.duplicateAcknowledgedIds.some((id) => !isPatientId(id)))
      ) {
        error =
          'Queued duplicate confirmation is malformed and was retained for review.';
      }
      if (error) {
        invalidActions.push(action);
        action.status = 'failed';
        await updateQueuedAction(action, {
          status: 'failed',
          retryable: false,
          nextRetryAt: null,
          lastError: error,
        });
        continue;
      }

      const operationId = action.operationId || crypto.randomUUID();
      if (operationId !== action.operationId) {
        const persisted = await updateQueuedAction(action, { operationId });
        if (!persisted) {
          throw new Error(
            'A stable operation ID could not be saved; the change was not sent.',
          );
        }
      }
      action.operationId = operationId;
      const operationData =
        action.type === 'DELETE'
          ? { id: payload.id, version: Number(payload.version) }
          : {
              id: payload.id,
              ...(action.type === 'EDIT'
                ? { version: Number(payload.version) }
                : {}),
              ...Object.fromEntries(
                PATIENT_SYNC_FIELDS.map((field) => [
                  field,
                  payload[field] ?? '',
                ]),
              ),
              ...(action.type === 'ADD' &&
              payload.allowPotentialDuplicates === true
                ? {
                    allowPotentialDuplicates: true,
                    duplicateAcknowledgedIds:
                      Array.isArray(payload.duplicateAcknowledgedIds)
                        ? payload.duplicateAcknowledgedIds
                        : [],
                  }
                : {}),
            };
      operations.push({
        operationId,
        type: action.type,
        table: 'patients',
        data: operationData,
        timestamp: action.timestamp,
      });
      validActions.push(action);
    }

    if (operations.length === 0) {
      const error =
        'No queued operations passed validation. Invalid entries are retained for review.';
      updateSyncMetadata({
        lastAttemptAt: new Date().toISOString(),
        lastOutcome: 'Failure',
        lastError: error,
      });
      dispatchQueueChanged();
      return {
        success: false,
        partial: false,
        processed: 0,
        conflicts: 0,
        unresolved: invalidActions.length + remainingQueueCount,
        error,
      };
    }

    const response = await fetch('/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': document.body.dataset.csrfToken || '',
      },
      body: JSON.stringify(operations),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(
        result?.error || `Synchronization failed with HTTP ${response.status}.`,
      );
      error.status = response.status;
      error.retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      const retryAfter = response.headers?.get?.('Retry-After');
      const retryAfterSeconds = Number(retryAfter);
      if (
        error.retryable &&
        Number.isFinite(retryAfterSeconds) &&
        retryAfterSeconds > 0
      ) {
        error.retryAfterMs = Math.min(retryAfterSeconds * 1000, 60 * 60 * 1000);
      } else if (error.retryable && retryAfter) {
        const retryAt = Date.parse(retryAfter);
        if (Number.isFinite(retryAt) && retryAt > Date.now()) {
          error.retryAfterMs = Math.min(retryAt - Date.now(), 60 * 60 * 1000);
        }
      }
      throw error;
    }
    if (!result || result.success !== true || !Array.isArray(result.results)) {
      throw new Error(
        result?.error || 'Server returned an invalid synchronization response.',
      );
    }

    const resultByOperation = new Map();
    for (const item of result.results) {
      if (
        !item ||
        typeof item.operationId !== 'string' ||
        resultByOperation.has(item.operationId) ||
        !['applied', 'already_applied', 'conflict', 'failed'].includes(
          item.status,
        )
      ) {
        throw new Error(
          'Server returned invalid per-operation synchronization results.',
        );
      }
      resultByOperation.set(item.operationId, item);
    }
    if (
      resultByOperation.size !== validActions.length ||
      validActions.some((action) => !resultByOperation.has(action.operationId))
    ) {
      throw new Error(
        'Server did not return a matching result for every queued operation.',
      );
    }

    const acknowledged = [];
    const unresolvedActions = [];
    for (const action of validActions) {
      const operationResult = resultByOperation.get(action.operationId);
      if (
        operationResult.status === 'applied' ||
        operationResult.status === 'already_applied'
      ) {
        action.status = 'applied';
        acknowledged.push({
          action,
          serverRecord: operationResult.serverRecord,
        });
      } else if (operationResult.status === 'conflict') {
        action.status = 'conflict';
        unresolvedActions.push(action);
        await updateQueuedAction(action, {
          status: 'conflict',
          retryable: false,
          conflictCode: operationResult.code || 'CONFLICT',
          conflictServer: operationResult.serverRecord || null,
          lastError:
            operationResult.reason ||
            'The server record changed. Review both versions before resolving.',
        });
      } else {
        action.status = 'failed';
        unresolvedActions.push(action);
        await updateQueuedAction(action, {
          status: 'failed',
          retryable: false,
          failureCode: operationResult.code || null,
          duplicateMatches: Array.isArray(operationResult.matches)
            ? operationResult.matches
            : [],
          lastError:
            operationResult.reason ||
            'The server rejected this operation. It remains queued for review.',
        });
      }
    }

    if (acknowledged.length > 0) {
      await db.transaction('rw', db.patients, db.syncQueue, async () => {
        for (const { action, serverRecord } of acknowledged) {
          if (serverRecord && isPatientId(serverRecord.id)) {
            await db.patients.put({
              ...serverRecord,
              ownerId: window.db.userId,
            });
          }
          await db.syncQueue.delete(action.id);
        }
      });
    }

    const complete =
      unresolvedActions.length === 0 &&
      invalidActions.length === 0 &&
      remainingQueueCount === 0 &&
      Number(result.conflicts || 0) === 0 &&
      Number(result.skipped || 0) === 0;
    const partial = !complete && response.ok;
    const outcome = complete
      ? 'Success'
      : partial
        ? 'Partial Failure'
        : 'Failure';
    const completed = acknowledged.length;
    window.dispatchEvent(
      new CustomEvent('healthsys:sync-progress', {
        detail: { completed, total: actions.length },
      }),
    );

    const metadata = {
      lastAttemptAt: result.syncedAt || new Date().toISOString(),
      lastOutcome: outcome,
      lastError: complete
        ? null
        : `${unresolvedActions.length + invalidActions.length + remainingQueueCount} operation(s) remain unconfirmed by the server.` +
          (result.conflicts ? ` ${result.conflicts} conflict(s).` : '') +
          (result.skipped ? ` ${result.skipped} operation(s) skipped.` : ''),
    };
    if (complete && acknowledged.length > 0) {
      metadata.lastSuccessfulAt = result.syncedAt || new Date().toISOString();
    }
    updateSyncMetadata(metadata);
    dispatchQueueChanged();

    return {
      ...result,
      success: complete,
      partial,
      processed: completed,
      unresolved:
        unresolvedActions.length + invalidActions.length + remainingQueueCount,
      error: complete ? null : metadata.lastError,
    };
  } catch (error) {
    console.error('[SYNC] FAILED:', error?.name || 'SYNC_ERROR');
    const status = Number(error?.status);
    const retryable =
      error?.retryable === true ||
      (!Number.isInteger(status) && error?.retryable !== false) ||
      status === 408 ||
      status === 429 ||
      status >= 500;
    for (const action of actions) {
      if (
        action.status === 'conflict' ||
        invalidActions.some((invalid) => invalid.id === action.id)
      )
        continue;
      const attemptCount = Math.max(1, Number(action.attemptCount) || 1);
      const delay = Math.min(
        60 * 60 * 1000,
        1000 * 2 ** Math.min(attemptCount, 12),
      );
      const retryDelay = Number.isFinite(error.retryAfterMs)
        ? error.retryAfterMs
        : delay * (0.5 + Math.random());
      const retryAt = retryable
        ? new Date(Date.now() + retryDelay).toISOString()
        : null;
      await updateQueuedAction(action, {
        status: 'failed',
        retryable,
        nextRetryAt: retryAt,
        lastError:
          'Synchronization could not be confirmed. The operation is retained for retry.',
      });
    }
    updateSyncMetadata({
      lastAttemptAt: new Date().toISOString(),
      lastOutcome: 'Failure',
      lastError:
        'Synchronization could not be confirmed. Queued changes were retained.',
    });
    return {
      success: false,
      partial: false,
      processed: 0,
      conflicts: 0,
      error:
        'Synchronization could not be confirmed. Queued changes were retained.',
    };
  }
}

async function updateQueuedAction(action, changes) {
  if (!Number.isSafeInteger(action?.id)) {
    console.error(
      '[SYNC] A malformed queue row has no valid local key and was retained for manual recovery.',
    );
    return false;
  }
  return (await db.syncQueue.update(action.id, changes)) > 0;
}

async function exportOfflineData() {
  if (!window.db.userId)
    throw new Error('Sign in before exporting local offline data.');
  if (!(await window.healthsysDBReady))
    throw new Error(window.healthsysDBError);
  const ownerId = window.db.userId;
  const patients = (await db.patients.toArray())
    .filter((patient) => patient.ownerId === ownerId)
    .map((patient) =>
      Object.fromEntries(
        PATIENT_SNAPSHOT_FIELDS.filter(
          (field) => patient[field] !== undefined,
        ).map((field) => [field, patient[field]]),
      ),
    );
  const pendingOperations = (await db.syncQueue.toArray())
    .filter((action) => action && action.ownerId === ownerId)
    .map((action) => safeOfflineOperation(action));
  return {
    format: LOCAL_BACKUP_FORMAT,
    version: LOCAL_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    ownerId,
    patients,
    pendingOperations,
  };
}

function safeOfflineOperation(action) {
  const validOperationId =
    typeof action.operationId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      action.operationId,
    );
  const validTimestamp =
    typeof action.timestamp === 'string' &&
    Number.isFinite(Date.parse(action.timestamp));
  const payload = action.payload;
  const validPayload =
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    isPatientId(payload.id);
  const supported =
    action.store === 'patients' &&
    ['ADD', 'EDIT', 'DELETE'].includes(action.type) &&
    validTimestamp &&
    validPayload &&
    (action.type !== 'DELETE' ||
      (Number.isSafeInteger(Number(payload.version)) &&
        Number(payload.version) > 0)) &&
    (action.type === 'DELETE' ||
      !PATIENT_SYNC_FIELDS.some(
        (field) =>
          payload[field] !== undefined && typeof payload[field] !== 'string',
      ));
  const safePayload = supported
    ? action.type === 'DELETE'
      ? { id: payload.id, version: Number(payload.version) }
      : {
          id: payload.id,
          ...Object.fromEntries(
            PATIENT_SYNC_FIELDS.map((field) => [field, payload[field] ?? '']),
          ),
        }
    : {};
  return {
    operationId: validOperationId ? action.operationId : null,
    type:
      typeof action.type === 'string' ? action.type.slice(0, 30) : 'UNKNOWN',
    store:
      typeof action.store === 'string' ? action.store.slice(0, 30) : 'unknown',
    payload: safePayload,
    timestamp: validTimestamp ? action.timestamp : null,
    status:
      supported && ['pending', 'conflict', 'failed'].includes(action.status)
        ? action.status
        : 'failed',
    conflictCode:
      typeof action.conflictCode === 'string'
        ? action.conflictCode.slice(0, 60)
        : null,
    conflictServer:
      action.conflictServer && isPatientId(action.conflictServer.id)
        ? Object.fromEntries(
            PATIENT_SNAPSHOT_FIELDS.filter(
              (field) => action.conflictServer[field] !== undefined,
            ).map((field) => [field, action.conflictServer[field]]),
          )
        : null,
    baseRecord:
      action.baseRecord &&
      isPatientId(action.baseRecord.id) &&
      action.baseRecord.id === payload?.id
        ? Object.fromEntries(
            PATIENT_SNAPSHOT_FIELDS.filter(
              (field) => action.baseRecord[field] !== undefined,
            ).map((field) => [field, action.baseRecord[field]]),
          )
        : null,
    retryable: action.status === 'failed' && action.retryable === true,
    attemptCount:
      Number.isSafeInteger(action.attemptCount) && action.attemptCount >= 0
        ? action.attemptCount
        : 0,
    lastAttemptAt:
      typeof action.lastAttemptAt === 'string' &&
      Number.isFinite(Date.parse(action.lastAttemptAt))
        ? action.lastAttemptAt
        : null,
    nextRetryAt:
      typeof action.nextRetryAt === 'string' &&
      Number.isFinite(Date.parse(action.nextRetryAt))
        ? action.nextRetryAt
        : null,
    reviewOnly: !supported,
    lastError: supported
      ? action.status === 'failed'
        ? 'This operation previously failed; diagnostic details are omitted.'
        : null
      : 'Unsupported or malformed operation; payload and diagnostic details were omitted.',
  };
}

async function importOfflineData(backup) {
  if (!window.db.userId)
    throw new Error('Sign in to the account that created this local backup.');
  if (!(await window.healthsysDBReady))
    throw new Error(window.healthsysDBError);
  if (
    !backup ||
    backup.format !== LOCAL_BACKUP_FORMAT ||
    backup.version !== LOCAL_BACKUP_VERSION ||
    backup.ownerId !== window.db.userId ||
    !Array.isArray(backup.patients) ||
    !Array.isArray(backup.pendingOperations) ||
    backup.patients.length + backup.pendingOperations.length > 20000
  ) {
    throw new Error(
      'This local backup is invalid, too large, or belongs to another account.',
    );
  }

  const isUuidValue = (value) =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  const patients = backup.patients.map((patient) => {
    if (!patient || !isPatientId(patient.id))
      throw new Error('The local backup contains an invalid patient record.');
    return Object.fromEntries(
      PATIENT_SNAPSHOT_FIELDS.filter(
        (field) => patient[field] !== undefined,
      ).map((field) => [field, patient[field]]),
    );
  });
  const operations = backup.pendingOperations.map((action) => {
    if (
      !action ||
      typeof action.store !== 'string' ||
      action.store.length > 30 ||
      typeof action.type !== 'string' ||
      action.type.length > 30
    ) {
      throw new Error('The local backup contains an invalid pending change.');
    }
    if (action.reviewOnly === true) {
      if (action.status !== 'failed') {
        throw new Error(
          'The local backup contains an unsupported operation that is not marked for review.',
        );
      }
      return {
        operationId: isUuidValue(action.operationId)
          ? action.operationId
          : null,
        ownerId: window.db.userId,
        type: action.type,
        store: action.store,
        payload: {},
        timestamp:
          typeof action.timestamp === 'string' &&
          Number.isFinite(Date.parse(action.timestamp))
            ? action.timestamp
            : new Date().toISOString(),
        status: 'failed',
        retryable: false,
        conflictServer: null,
        lastError:
          'Unsupported or malformed operation; payload and diagnostic details were omitted.',
      };
    }
    if (
      action.store !== 'patients' ||
      !['ADD', 'EDIT', 'DELETE'].includes(action.type) ||
      !action.payload ||
      typeof action.payload !== 'object' ||
      Array.isArray(action.payload) ||
      !isPatientId(action.payload.id) ||
      typeof action.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(action.timestamp))
    ) {
      throw new Error('The local backup contains an invalid pending change.');
    }
    let baseRecord = null;
    if (action.baseRecord !== undefined && action.baseRecord !== null) {
      if (
        !action.baseRecord ||
        typeof action.baseRecord !== 'object' ||
        Array.isArray(action.baseRecord) ||
        action.baseRecord.id !== action.payload.id ||
        !Number.isSafeInteger(Number(action.baseRecord.version)) ||
        Number(action.baseRecord.version) < 1 ||
        PATIENT_SYNC_FIELDS.some(
          (field) =>
            action.baseRecord[field] !== undefined &&
            typeof action.baseRecord[field] !== 'string',
        )
      ) {
        throw new Error('The local backup contains an invalid conflict snapshot.');
      }
      baseRecord = Object.fromEntries(
        PATIENT_SNAPSHOT_FIELDS.filter(
          (field) => action.baseRecord[field] !== undefined,
        ).map((field) => [field, action.baseRecord[field]]),
      );
    }
    let payload = { id: action.payload.id };
    if (action.type === 'DELETE') {
      const version = Number(action.payload.version);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new Error(
          'The local backup contains an invalid deletion operation.',
        );
      }
      payload.version = version;
    } else {
      if (
        !isPatientId(action.payload.id) ||
        PATIENT_SNAPSHOT_FIELDS.some(
          (field) =>
            field !== 'id' &&
            action.payload[field] !== undefined &&
            typeof action.payload[field] !== 'string' &&
            typeof action.payload[field] !== 'number' &&
            typeof action.payload[field] !== 'boolean',
        )
      ) {
        throw new Error('The local backup contains an invalid patient change.');
      }
      payload = Object.fromEntries(
        PATIENT_SNAPSHOT_FIELDS.filter(
          (field) => action.payload[field] !== undefined,
        ).map((field) => [field, action.payload[field]]),
      );
    }
    return {
      operationId: isUuidValue(action.operationId)
        ? action.operationId
        : crypto.randomUUID(),
      ownerId: window.db.userId,
      type: action.type,
      store: 'patients',
      payload,
      timestamp: action.timestamp,
      status: ['pending', 'conflict', 'failed'].includes(action.status)
        ? action.status
        : 'failed',
      conflictCode:
        typeof action.conflictCode === 'string'
          ? action.conflictCode.slice(0, 60)
          : null,
      conflictServer:
        action.conflictServer && isPatientId(action.conflictServer.id)
          ? Object.fromEntries(
              PATIENT_SNAPSHOT_FIELDS.filter(
                (field) => action.conflictServer[field] !== undefined,
              ).map((field) => [field, action.conflictServer[field]]),
            )
          : null,
      baseRecord,
      retryable: action.status === 'failed' && action.retryable === true,
      attemptCount:
        Number.isSafeInteger(action.attemptCount) && action.attemptCount >= 0
          ? action.attemptCount
          : 0,
      lastAttemptAt:
        typeof action.lastAttemptAt === 'string' &&
        Number.isFinite(Date.parse(action.lastAttemptAt))
          ? action.lastAttemptAt
          : null,
      nextRetryAt:
        typeof action.nextRetryAt === 'string' &&
        Number.isFinite(Date.parse(action.nextRetryAt))
          ? action.nextRetryAt
          : null,
      lastError:
        typeof action.lastError === 'string'
          ? action.lastError.slice(0, 500)
          : null,
    };
  });

  let importedPatients = 0;
  let importedOperations = 0;
  await withLocalWrite(() =>
    db.transaction('rw', db.patients, db.syncQueue, async () => {
      const existingPatients = new Set(
        (await db.patients.toArray()).map((patient) => patient.id),
      );
      for (const patient of patients) {
        if (existingPatients.has(patient.id)) continue;
        await db.patients.add({ ...patient, ownerId: window.db.userId });
        existingPatients.add(patient.id);
        importedPatients++;
      }

      const existingOperationIds = new Set(
        (await db.syncQueue.toArray())
          .map((action) => action?.operationId)
          .filter(Boolean),
      );
      for (const action of operations) {
        if (existingOperationIds.has(action.operationId)) continue;
        await db.syncQueue.add(action);
        existingOperationIds.add(action.operationId);
        importedOperations++;
      }
    }),
  );
  dispatchQueueChanged();
  return { importedPatients, importedOperations };
}

// =============================
// 🌍 GLOBAL EXPORTS
// =============================

console.log('[DB.JS] Creating window.db');

window.db = {
  patients: db.patients,
  syncQueue: db.syncQueue,

  savePatients,
  getPatients,
  getPatient,
  getQueueStatus,
  getConflictedOperations,
  getFailedOperations,
  continueFailedPatientAdd,
  correctFailedOperation,
  resolveConflict,
  saveDashboardMetrics,
  getDashboardMetrics,
  getSyncMetadata: readSyncMetadata,
  recoverInterruptedSync,

  addLocalPatient,
  addLocalPatientAndQueue,
  updateLocalPatient,
  updateLocalPatientAndQueue,
  deleteLocalPatient,

  queueAction,
  queuePatientDeletion,
  syncPendingData,
  exportOfflineData,
  importOfflineData,
  databaseReady: () => window.healthsysDBReady,
  isBusy: () => databaseOpening || Boolean(syncPromise) || localWriteCount > 0,
  setOfflineUser(userId) {
    if (typeof userId !== 'string' || !userId) {
      throw new Error('A previously verified account is required for offline access.');
    }
    window.db.userId = userId;
  },
  async setCurrentUser(userId) {
    return withLocalWrite(async () => {
      const previousUserId = window.db.userId || null;
      const nextUserId = userId || previousUserId || null;
      const metadataOwnerId = readSyncMetadata().ownerId || null;
      window.db.userId = nextUserId;
      updateSyncMetadata({});

      const ownershipChanged =
        !!previousUserId && previousUserId !== nextUserId;
      const metadataOwnerChanged =
        !!metadataOwnerId && metadataOwnerId !== nextUserId;

      if (nextUserId && (ownershipChanged || metadataOwnerChanged)) {
        updateSyncMetadata({
          lastAttemptAt: null,
          lastSuccessfulAt: null,
          lastOutcome: null,
          lastError: null,
        });
        await db.dashboardMetrics.clear();
      }

      if (nextUserId) {
        await db.patients
          .toCollection()
          .filter((patient) => patient.ownerId !== nextUserId)
          .delete();
        await db.syncQueue
          .toCollection()
          .filter(
            (action) =>
              action && action.store === 'patients' && !action.ownerId,
          )
          .modify({
            ownerId: 'unassigned',
            status: 'failed',
            lastError:
              'This queued change predates account isolation and requires administrator review.',
          });
      }

      if (previousUserId && previousUserId !== nextUserId) {
        await db.patients
          .toCollection()
          .filter((patient) => patient.ownerId === previousUserId)
          .delete();
      }
    });
  },
  async clearSensitiveLocalData() {
    await withLocalWrite(async () => {
      await db.patients.clear();
      await db.dashboardMetrics.clear();
      try {
        localStorage.removeItem(syncMetadataKey());
      } catch (error) {
        console.error('[SYNC] Could not clear local sync metadata:', error);
      }
    });
  },
};
