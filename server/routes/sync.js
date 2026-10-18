const express = require('express');
const router = express.Router();
const pool = require('../db');
const {
  requireAuth,
  sensitiveCsrf,
} = require('../middleware/auth');
const { isUuid, normalizePatientData } = require('../patient_validation');
const { operationPayloadHash } = require('../sync_operation');
const patientRepository = require('../patient_repository');
const logger = require('../logger');
const { writeAuditEvent } = require('../audit');
const { PATIENT_FIELDS } = require('../patient_validation');
const {
  findPotentialDuplicates,
  lockDuplicateKeys,
} = require('../patient_duplicates');

function validationError(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    return 'Operation must be an object.';
  }
  if (!isUuid(operation.operationId))
    return 'A valid operation UUID is required.';
  if (operation.table !== 'patients')
    return 'Only patient operations are supported.';
  if (!['ADD', 'EDIT', 'DELETE'].includes(operation.type))
    return 'Unsupported operation type.';
  if (
    !operation.data ||
    typeof operation.data !== 'object' ||
    Array.isArray(operation.data)
  ) {
    return 'Operation data must be an object.';
  }
  if (operation.type === 'ADD' || operation.type === 'EDIT') {
    if (!isUuid(operation.data.id)) return 'A valid patient UUID is required.';
    if (
      operation.type === 'EDIT' &&
      (!Number.isSafeInteger(Number(operation.data.version)) ||
        Number(operation.data.version) < 1)
    ) {
      return 'A valid patient version is required for edits.';
    }
    const validation = normalizePatientData(operation.data);
    if (validation.error) return validation.error;
    if (operation.type === 'ADD' &&
      operation.data.allowPotentialDuplicates !== undefined &&
      typeof operation.data.allowPotentialDuplicates !== 'boolean') {
      return 'Duplicate confirmation is invalid.';
    }
    if (operation.type === 'ADD' &&
      operation.data.duplicateAcknowledgedIds !== undefined &&
      (!Array.isArray(operation.data.duplicateAcknowledgedIds) ||
        operation.data.duplicateAcknowledgedIds.length > 40 ||
        operation.data.duplicateAcknowledgedIds.some((id) => !isUuid(id)))) {
      return 'Duplicate confirmation is invalid.';
    }
    return null;
  }
  if (!isUuid(operation.data.id)) return 'A valid patient UUID is required.';
  if (
    !Number.isSafeInteger(Number(operation.data.version)) ||
    Number(operation.data.version) < 1
  ) {
    return 'A valid patient version is required.';
  }
  return null;
}

async function logSyncActivity(connection, {
  patientId,
  actorId,
  actorRole,
  action,
  operationId,
  fields = [],
}) {
  const details = JSON.stringify({
    actorRole,
    fields,
    operationId,
    source: 'sync',
  });
  await connection.execute(
    `INSERT INTO patient_activity
     (patient_id, user_id, action, details, operation_id)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [patientId, actorId, action, details, operationId],
  );
}

function patientValue(value, field) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? '').trim();
  return field === 'date_of_birth' ? text.slice(0, 10) : text;
}

router.use(requireAuth);
router.use(sensitiveCsrf);

router.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const operations = req.body;
  if (!Array.isArray(operations) || operations.length > 500) {
    return res.status(400).json({ error: 'Expected array of operations' });
  }

  let connection;
  let successCount = 0;
  let conflictCount = 0;
  let skippedCount = 0;
  const resolvedIndexes = [];
  const conflicts = [];
  const failures = [];
  const results = [];

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    for (
      let operationIndex = 0;
      operationIndex < operations.length;
      operationIndex++
    ) {
      const op = operations[operationIndex];
      const actor = req.session.user.id;
      if (
        op &&
        typeof op === 'object' &&
        !Array.isArray(op) &&
        op.table === 'users'
      ) {
        skippedCount++;
        failures.push({
          index: operationIndex,
          reason:
            'Legacy user-account sync operations are rejected for security and replay protection.',
        });
        results.push({
          index: operationIndex,
          operationId: op.operationId || null,
          status: 'failed',
          code: 'UNSUPPORTED_OPERATION',
          reason: 'Legacy user-account sync operations are not supported.',
        });
        continue;
      }
      const invalidReason = validationError(op);
      if (invalidReason) {
        skippedCount++;
        failures.push({ index: operationIndex, reason: invalidReason });
        results.push({
          index: operationIndex,
          operationId: op?.operationId || null,
          status: 'failed',
          code: 'VALIDATION_FAILED',
          reason: invalidReason,
        });
        continue;
      }
      if (op.type === 'DELETE' && req.session.user.role !== 'admin') {
        skippedCount++;
        failures.push({
          index: operationIndex,
          reason: 'Only administrators may delete patient records.',
        });
        results.push({
          index: operationIndex,
          operationId: op.operationId,
          status: 'failed',
          code: 'FORBIDDEN',
          reason: 'Only administrators may delete patient records.',
        });
        continue;
      }

      const hash = operationPayloadHash(op.type, op.table, op.data);
      const [priorOperations] = await connection.execute(
        'SELECT payload_hash FROM sync_operations WHERE operation_id = ?',
        [op.operationId],
      );
      if (priorOperations.length) {
        if (priorOperations[0].payload_hash !== hash) {
          conflictCount++;
          const current = await patientRepository.findById(
            connection,
            op.data.id,
            { forUpdate: true },
          );
          conflicts.push({
            index: operationIndex,
            id: op.data.id,
            reason: 'operation_id_reused',
            serverVersion: current?.version ?? null,
          });
          results.push({
            index: operationIndex,
            operationId: op.operationId,
            status: 'conflict',
            code: 'OPERATION_ID_REUSED',
            reason:
              'This operation ID was already used for a different change.',
            serverRecord: current,
          });
          continue;
        }
        successCount++;
        resolvedIndexes.push(operationIndex);
        results.push({
          index: operationIndex,
          operationId: op.operationId,
          status: 'already_applied',
          serverRecord: await patientRepository.findById(
            connection,
            op.data.id,
          ),
        });
        continue;
      }

      const data = op.data;
      const values =
        op.type === 'ADD' || op.type === 'EDIT'
          ? normalizePatientData(data).data
          : null;
      if (op.type === 'ADD') {
        const existing = await patientRepository.findById(connection, data.id);
        if (existing) {
          await logSyncActivity(connection, {
            patientId: data.id,
            actorId: actor,
            actorRole: req.session.user.role,
            action: 'sync conflict',
            operationId: op.operationId,
          });
          await writeAuditEvent(connection, {
            actorId: actor,
            actorRole: req.session.user.role,
            action: 'patient.sync.conflict',
            targetId: data.id,
            entityType: 'patient',
            entityId: data.id,
            outcome: 'conflict',
            requestId: req.requestId || null,
            operationId: op.operationId,
            details: { category: 'duplicate_id', operationType: op.type },
            failureCategory: 'duplicate_id',
          });
          conflictCount++;
          conflicts.push({
            index: operationIndex,
            id: data.id,
            reason: 'duplicate_id',
            serverVersion: existing.version ?? null,
          });
          results.push({
            index: operationIndex,
            operationId: op.operationId,
            status: 'conflict',
            code: 'DUPLICATE_PATIENT_ID',
            reason: 'A patient with this ID already exists.',
            serverRecord: existing,
          });
          continue;
        }
        await lockDuplicateKeys(connection, values);
        const matches = await findPotentialDuplicates(connection, values);
        const acknowledged = data.allowPotentialDuplicates === true
          ? new Set(data.duplicateAcknowledgedIds || [])
          : new Set();
        if (matches.some((match) => !acknowledged.has(match.id))) {
          skippedCount++;
          results.push({
            index: operationIndex,
            operationId: op.operationId,
            status: 'failed',
            code: 'POTENTIAL_DUPLICATE',
            reason: 'Possible matching patient records require review. The queued patient was preserved.',
            matches,
          });
          continue;
        }
        await patientRepository.create(connection, {
          id: data.id,
          data: values,
          actorId: actor,
        });
        await logSyncActivity(connection, {
          patientId: data.id,
          actorId: actor,
          actorRole: req.session.user.role,
          action: 'created',
          operationId: op.operationId,
          fields: PATIENT_FIELDS,
        });
      } else {
        const expectedVersion = Number(data.version);
        const before = await patientRepository.findById(connection, data.id, {
          forUpdate: true,
        });
        const updated = await patientRepository.updateIfVersion(connection, {
          id: data.id,
          data: op.type === 'EDIT' ? values : null,
          actorId: actor,
          expectedVersion,
          deleted: op.type === 'DELETE' ? true : undefined,
        });
        if (!updated) {
          const current = await patientRepository.findById(
            connection,
            data.id,
            { forUpdate: true },
          );
          if (op.type === 'DELETE' && current?.is_deleted) {
            await connection.execute(
              `INSERT INTO sync_operations (operation_id, payload_hash, patient_id, operation_type)
                       VALUES (?, ?, ?, ?)`,
              [op.operationId, hash, data.id, op.type],
            );
            await writeAuditEvent(connection, {
              actorId: actor,
              actorRole: req.session.user.role,
              action: 'patient.sync.delete',
              targetId: data.id,
              entityType: 'patient',
              entityId: data.id,
              outcome: 'already_applied',
              requestId: req.requestId || null,
              operationId: op.operationId,
              details: { operationType: op.type },
            });
            successCount++;
            resolvedIndexes.push(operationIndex);
            results.push({
              index: operationIndex,
              operationId: op.operationId,
              status: 'already_applied',
              serverRecord: current,
            });
            continue;
          }
          await writeAuditEvent(connection, {
            actorId: actor,
            actorRole: req.session.user.role,
            action: 'patient.sync.conflict',
            targetId: data.id,
            entityType: 'patient',
            entityId: data.id,
            outcome: 'conflict',
            requestId: req.requestId || null,
            operationId: op.operationId,
            details: {
              category: current ? 'version_mismatch' : 'not_found',
              operationType: op.type,
            },
            failureCategory: current ? 'version_mismatch' : 'not_found',
          });
          if (current) {
            await logSyncActivity(connection, {
              patientId: data.id,
              actorId: actor,
              actorRole: req.session.user.role,
              action: 'sync conflict',
              operationId: op.operationId,
            });
          }
          conflictCount++;
          conflicts.push({
            index: operationIndex,
            id: data.id,
            reason: current ? 'version_mismatch' : 'not_found',
            serverVersion: current?.version ?? null,
          });
          results.push({
            index: operationIndex,
            operationId: op.operationId,
            status: 'conflict',
            code: current ? 'VERSION_MISMATCH' : 'PATIENT_NOT_FOUND',
            reason: current
              ? 'The patient changed since this operation was created.'
              : 'The patient no longer exists on the server.',
            serverRecord: current,
          });
          continue;
        }
        const changedFields =
          op.type === 'EDIT'
            ? PATIENT_FIELDS.filter(
                (field) =>
                  patientValue(before?.[field], field) !== values[field],
              )
            : [];
        await logSyncActivity(connection, {
          patientId: data.id,
          actorId: actor,
          actorRole: req.session.user.role,
          action: op.type === 'EDIT' ? 'updated' : 'deleted',
          operationId: op.operationId,
          fields: changedFields,
        });
      }

      await connection.execute(
        `INSERT INTO sync_operations (operation_id, payload_hash, patient_id, operation_type)
                 VALUES (?, ?, ?, ?)`,
        [op.operationId, hash, data.id, op.type],
      );
      await writeAuditEvent(connection, {
        actorId: actor,
        actorRole: req.session.user.role,
        action: `patient.sync.${op.type.toLowerCase()}`,
        targetId: data.id,
        entityType: 'patient',
        entityId: data.id,
        requestId: req.requestId || null,
        operationId: op.operationId,
        details: {
          fields: op.type === 'EDIT' ? PATIENT_FIELDS : [],
          operationType: op.type,
        },
      });
      successCount++;
      resolvedIndexes.push(operationIndex);
      results.push({
        index: operationIndex,
        operationId: op.operationId,
        status: 'applied',
        serverRecord: await patientRepository.findById(connection, data.id),
      });
    }

    const syncedAt = new Date();
    const syncComplete =
      resolvedIndexes.length === operations.length &&
      conflictCount === 0 &&
      skippedCount === 0;
    await writeAuditEvent(connection, {
      actorId: req.session.user.id,
      actorRole: req.session.user.role,
      action: 'patient.sync',
      outcome: syncComplete ? 'success' : 'partial',
      requestId: req.requestId || null,
      details: {
        operationCount: operations.length,
        applied: successCount,
        conflicts: conflictCount,
        rejected: skippedCount,
      },
      failureCategory:
        skippedCount > 0
          ? 'operation_rejected'
          : conflictCount > 0
            ? 'operation_conflict'
            : null,
    });
    await connection.commit();
    try {
      await connection.execute(
        'INSERT INTO sync_logs (user_id, action_type, success, conflict_detected, operation_count, synced_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          req.session.user.id,
          'BULK_SYNC',
          syncComplete,
          conflictCount > 0,
          operations.length,
          syncedAt,
        ],
      );
    } catch (logErr) {
      logger.error('sync.statistics_log.failed', {
        requestId: req.requestId,
        errorCode: logErr.code || 'DATABASE_ERROR',
      });
      try {
        await connection.execute(
          'INSERT INTO sync_logs (user_id, operation_count, synced_at) VALUES (?, ?, ?)',
          [req.session.user.id, operations.length, syncedAt],
        );
      } catch (legacyLogErr) {
        logger.error('sync.legacy_log.failed', {
          requestId: req.requestId,
          errorCode: legacyLogErr.code || 'DATABASE_ERROR',
        });
      }
    }

    res.json({
      success: true,
      complete: syncComplete,
      processed: successCount,
      conflicts: conflictCount,
      skipped: skippedCount,
      resolvedIndexes,
      conflictDetails: conflicts,
      failures,
      results,
      syncedAt: syncedAt.toISOString(),
    });
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error('sync.batch.failed', {
      requestId: req.requestId,
      errorCode: err.code || 'DATABASE_ERROR',
    });

    try {
      const logPool = require('../db');
      await logPool.execute(
        'INSERT INTO sync_logs (user_id, action_type, success, conflict_detected, operation_count, synced_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [req.session.user.id, 'BULK_SYNC', false, false, operations.length],
      );
    } catch (e) {
      logger.error('sync.failure_log.failed', {
        requestId: req.requestId,
        errorCode: e.code || 'DATABASE_ERROR',
      });
    }

    res
      .status(500)
      .json({ error: 'Sync failed; queued operations were not confirmed.' });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
