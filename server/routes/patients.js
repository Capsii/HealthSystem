const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();
const pool = require('../db');
const { requireAuth, sensitiveCsrf, recordAudit } = require('../middleware/auth');
const patientRepository = require('../patient_repository');
const logger = require('../logger');
const {
    PATIENT_FIELDS,
    isDateOnly,
    isUuid,
    normalizePatientData,
} = require('../patient_validation');
const { operationPayloadHash } = require('../sync_operation');
const {
    CSV_HEADERS,
    MAX_IMPORT_BYTES,
    csvRow,
    patientCsvValues,
} = require('../patient_csv');
const { writeAuditEvent } = require('../audit');
const { getPatientCompletenessWarnings } = require('../patient_completeness');
const {
    findPotentialDuplicates,
    lockDuplicateKeys,
} = require('../patient_duplicates');
const { isVisitId, normalizeVisitInput } = require('../visit_validation');

const MAX_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / Math.max(...patientRepository.PAGE_SIZES));
function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
        ? parsed
        : fallback;
}

function isAdmin(req) {
    return req.session.user.role === 'admin';
}

function isClinicalStaff(req) {
    return ['admin', 'staff'].includes(req.session.user.role);
}

function respondError(req, res, status, error, redirect) {
    if (req.headers.accept?.includes('application/json')) {
        return res.status(status).json({ success: false, error });
    }
    return res.redirect(redirect);
}

function patientListReturnPath(value) {
    if (typeof value !== 'string' || value.length > 2048) return '/patients';
    try {
        const url = new URL(value, 'http://healthsys.local');
        if (url.origin !== 'http://healthsys.local' || url.pathname !== '/patients') {
            return '/patients';
        }
        return `${url.pathname}${url.search}`;
    } catch {
        return '/patients';
    }
}

function patientProfilePath(id, returnTo, extra = {}) {
    const params = new URLSearchParams(extra);
    const safeReturnTo = patientListReturnPath(returnTo);
    if (safeReturnTo !== '/patients') params.set('returnTo', safeReturnTo);
    const query = params.toString();
    return `/patients/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;
}

async function logActivity(
    connection,
    patientId,
    userId,
    action,
    details = null,
    operationId = null,
) {
    await connection.execute(
        `INSERT INTO patient_activity
         (patient_id, user_id, action, details, operation_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [patientId, userId, action, details, operationId],
    );
}

async function logPatientAudit(connection, req, action, patientId, details = null) {
    await writeAuditEvent(connection, {
        actorId: req.session.user.id,
        actorRole: req.session.user.role,
        action,
        targetId: patientId,
        entityType: 'patient',
        entityId: patientId,
        requestId: req.requestId || null,
        operationId: details?.operationId || null,
        details,
    });
}

const VISIT_VITAL_FIELDS = [
    'systolic_mmhg',
    'diastolic_mmhg',
    'pulse_bpm',
    'temperature_celsius',
    'respiratory_rate_per_minute',
    'oxygen_saturation_percent',
    'height_cm',
    'weight_kg',
];

function hasVisitVitals(vitals) {
    return VISIT_VITAL_FIELDS.some((field) => vitals[field] !== null);
}

async function addVisitVitals(connection, visitId, actorId, vitals) {
    if (!hasVisitVitals(vitals)) return;
    await connection.execute(
        `INSERT INTO patient_visit_vitals
         (visit_id, recorded_by, ${VISIT_VITAL_FIELDS.join(', ')})
         VALUES (?, ?, ${VISIT_VITAL_FIELDS.map(() => '?').join(', ')})`,
        [visitId, actorId, ...VISIT_VITAL_FIELDS.map((field) => vitals[field])],
    );
}

async function recordVisitEvent(connection, req, {
    visitId,
    patientId,
    eventType,
    details,
}) {
    await connection.execute(
        `INSERT INTO patient_visit_events
         (visit_id, patient_id, actor_id, event_type, details)
         VALUES (?, ?, ?, ?, ?)`,
        [
            visitId,
            patientId,
            req.session.user.id,
            eventType,
            JSON.stringify(details),
        ],
    );
    await logPatientAudit(
        connection,
        req,
        `patient.visit.${eventType}`,
        patientId,
        { visitId, eventType },
    );
}

function activityDetails(action, fields, req, operationId = null) {
    return JSON.stringify({
        actorRole: req.session.user.role,
        fields,
        operationId,
    });
}

router.use(requireAuth);
router.use(sensitiveCsrf);

router.get('/', async (req, res) => {
    const search = String(req.query.search || '').trim().slice(0, 100);
    const gender = ['male', 'female', 'other'].includes(String(req.query.gender).toLowerCase())
        ? String(req.query.gender).toLowerCase()
        : '';
    let status = ['active', 'deleted', 'all'].includes(req.query.status)
        ? req.query.status
        : 'active';
    if (!isAdmin(req)) status = 'active';
    const sort = Object.prototype.hasOwnProperty.call(patientRepository.SORT_COLUMNS, req.query.sort)
        ? req.query.sort
        : 'created_at';
    const direction = String(req.query.direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const requestedSize = parsePositiveInteger(req.query.pageSize, 25, 100);
    const pageSize = patientRepository.PAGE_SIZES.includes(requestedSize) ? requestedSize : 25;
    const page = parsePositiveInteger(req.query.page, 1, MAX_PAGE);
    const fromDate = String(req.query.fromDate || '');
    const toDate = String(req.query.toDate || '');

    if ((fromDate && !isDateOnly(fromDate)) || (toDate && !isDateOnly(toDate))) {
        return res.status(400).render('patients', {
            user: req.session.user,
            csvMaxBytes: MAX_IMPORT_BYTES,
            patients: [],
            query: req.query,
            counts: { total: 0, filtered: 0 },
            pagination: { page: 1, pageSize, pages: 1 },
            error: 'Enter valid date filters.',
        });
    }

    try {
        const result = await patientRepository.listPage(pool, {
            search,
            gender,
            status,
            fromDate,
            toDate,
            sort,
            direction,
            pageSize,
            page,
        });
        res.render('patients', {
            user: req.session.user,
            csvMaxBytes: MAX_IMPORT_BYTES,
            patients: result.patients,
            query: { ...req.query, search, gender, status, sort, direction, pageSize },
            counts: result.counts,
            pagination: result.pagination,
            message: {
                add_failed: 'Patient could not be added.',
                delete_failed: 'Patient could not be deleted.',
                restore_failed: 'Patient could not be restored.',
                forbidden: 'Your account does not have permission to perform that action.',
                invalid_patient: 'Check the patient details and date fields.',
            }[req.query.error] || null,
            error: null,
        });
    } catch (err) {
        logger.error('patient.list.failed', {
            requestId: req.requestId,
            errorCode: err.code || 'DATABASE_ERROR',
        });
        res.status(500).render('patients', {
            user: req.session.user,
            patients: [],
            query: { ...req.query, search, gender, status, sort, direction, pageSize },
            counts: { total: 0, filtered: 0 },
            pagination: { page: 1, pageSize, pages: 1 },
            message: null,
            error: 'Patient records could not be loaded. Please try again.',
        });
    }
});

router.get('/json', async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        const patients = await patientRepository.getActive(pool);
        res.json(patients);
    } catch (err) {
        logger.error('patient.api.list.failed', {
            requestId: req.requestId,
            errorCode: err.code || 'DATABASE_ERROR',
        });
        res.status(500).json({ error: 'Database error' });
    }
});

router.get('/export.csv', async (req, res) => {
    const scope = req.query.scope === 'filtered' ? 'filtered' : 'all';
    const requestsDeleted =
        req.query.includeDeleted === 'true' ||
        (scope === 'filtered' && ['deleted', 'all'].includes(req.query.status));
    if (requestsDeleted && !isAdmin(req)) {
        return res.status(403).send('Administrator access is required to export deleted patient records.');
    }
    const includeDeleted = req.query.includeDeleted === 'true' && isAdmin(req);
    const search = scope === 'filtered'
        ? String(req.query.search || '').trim().slice(0, 100)
        : '';
    const gender = scope === 'filtered' &&
        ['male', 'female', 'other'].includes(String(req.query.gender || '').toLowerCase())
        ? String(req.query.gender).toLowerCase()
        : '';
    let status = scope === 'filtered' &&
        ['active', 'deleted', 'all'].includes(req.query.status)
        ? req.query.status
        : 'active';
    if (!isAdmin(req)) status = 'active';
    const fromDate = scope === 'filtered' ? String(req.query.fromDate || '') : '';
    const toDate = scope === 'filtered' ? String(req.query.toDate || '') : '';
    if ((fromDate && !isDateOnly(fromDate)) || (toDate && !isDateOnly(toDate))) {
        return res.status(400).send('Enter valid date filters before exporting.');
    }
    const filters = patientRepository.buildPatientFilters({
        search,
        gender,
        status: scope === 'all' && includeDeleted ? 'all' : status,
        fromDate,
        toDate,
    });
    const { where, params } = filters;
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [[countRow]] = await connection.execute(
            `SELECT COUNT(*) AS total FROM patients ${where}`,
            params,
        );
        const exportedCount = Number(countRow.total);
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="patients-${new Date().toISOString().replace(/[:.]/g, '-')}.csv"`,
            'X-Content-Type-Options': 'nosniff',
            'X-Exported-Records': String(exportedCount),
        });

        const write = async (chunk) => {
            if (res.write(chunk)) return;
            await new Promise((resolve, reject) => {
                const cleanup = () => {
                    res.removeListener('drain', onDrain);
                    res.removeListener('error', onError);
                    res.removeListener('close', onClose);
                };
                const onDrain = () => {
                    cleanup();
                    resolve();
                };
                const onError = (error) => {
                    cleanup();
                    reject(error);
                };
                const onClose = () => {
                    cleanup();
                    reject(new Error('CSV download was interrupted.'));
                };
                res.once('drain', onDrain);
                res.once('error', onError);
                res.once('close', onClose);
            });
        };

        await write(`\uFEFF${csvRow(CSV_HEADERS)}\r\n`);
        let lastId = null;
        while (true) {
            const cursorClause = lastId === null
                ? ''
                : `${where ? ' AND' : 'WHERE'} id > ?`;
            const pageParams = [...params];
            if (lastId !== null) pageParams.push(lastId);
            const [patients] = await connection.execute(
                `SELECT ${CSV_HEADERS.join(', ')} FROM patients ${where}${cursorClause}
                 ORDER BY id ASC LIMIT 500`,
                pageParams
            );
            if (!patients.length) break;
            for (const patient of patients) {
                await write(`${csvRow(patientCsvValues(patient))}\r\n`);
            }
            lastId = patients[patients.length - 1].id;
        }

        await writeAuditEvent(connection, {
            actorId: req.session.user.id,
            actorRole: req.session.user.role,
            action: 'patient.export.csv',
            entityType: 'patient',
            outcome: 'success',
            requestId: req.requestId || null,
            details: {
                scope,
                status: scope === 'all' && includeDeleted ? 'all' : status,
                filtered: scope === 'filtered',
                exportedCount,
            },
        });
        await connection.commit();
        connection.release();
        connection = null;
        return res.end();
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                logger.error('patient.export.rollback_failed', {
                    requestId: req.requestId,
                    errorCode: rollbackError.code || 'DATABASE_ERROR',
                });
            }
            connection.release();
            connection = null;
        }
        await recordAudit({
            actorId: req.session.user.id,
            action: 'patient.export.csv',
            outcome: 'failure',
            requestId: req.requestId || null,
        });
        logger.error('patient.export.failed', {
            requestId: req.requestId,
            errorCode: error.code || 'EXPORT_ERROR',
        });
        if (!res.headersSent) {
            return res.status(500).send('Patient export failed. Please try again.');
        }
        return res.destroy();
    } finally {
        if (connection) connection.release();
    }
});

router.post('/add', async (req, res) => {
    if (!isClinicalStaff(req)) return respondError(req, res, 403, 'Staff access is required.', '/patients?error=forbidden');
    const id = req.body?.id;
    if (!isUuid(id)) {
        return respondError(req, res, 400, 'A valid patient UUID is required.', '/patients?error=invalid_patient');
    }
    if (!isUuid(req.body?.operationId)) {
        return respondError(req, res, 400, 'A valid operation UUID is required.', '/patients?error=invalid_patient');
    }
    if (req.body.allowPotentialDuplicates !== undefined &&
        typeof req.body.allowPotentialDuplicates !== 'boolean') {
        return res.status(400).json({ success: false, error: 'Duplicate confirmation is invalid.' });
    }
    const acknowledgedIds = req.body.duplicateAcknowledgedIds;
    if (acknowledgedIds !== undefined &&
        (!Array.isArray(acknowledgedIds) || acknowledgedIds.length > 40 ||
            acknowledgedIds.some((candidateId) => !isUuid(candidateId)))) {
        return res.status(400).json({ success: false, error: 'Duplicate confirmation is invalid.' });
    }
    const validation = normalizePatientData(req.body);
    if (validation.error) return respondError(req, res, 400, validation.error, '/patients?error=invalid_patient');
    const { data } = validation;
    const operationData = { ...req.body };
    delete operationData.operationId;
    const hash = operationPayloadHash('ADD', 'patients', operationData);

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [priorOperations] = await connection.execute(
            'SELECT payload_hash, patient_id FROM sync_operations WHERE operation_id = ?',
            [req.body.operationId]
        );
        if (priorOperations.length) {
            await connection.rollback();
            if (priorOperations[0].payload_hash !== hash) {
                return res.status(409).json({ success: false, error: 'Operation ID was already used for different patient data.' });
            }
            return res.json({ success: true, message: 'Patient was already added.', id: priorOperations[0].patient_id });
        }
        await lockDuplicateKeys(connection, data);
        const matches = await findPotentialDuplicates(connection, data);
        const acknowledged = req.body.allowPotentialDuplicates === true
            ? new Set(acknowledgedIds || [])
            : new Set();
        if (matches.some((match) => !acknowledged.has(match.id))) {
            await connection.rollback();
            return res.status(409).json({
                success: false,
                code: 'POTENTIAL_DUPLICATE',
                error: 'Possible matching patient records were found. Review them before continuing.',
                matches,
            });
        }
        await patientRepository.create(connection, { id, data, actorId: req.session.user.id });
        const activity = activityDetails(
            'created',
            PATIENT_FIELDS,
            req,
            req.body.operationId,
        );
        await logActivity(
            connection,
            id,
            req.session.user.id,
            'created',
            activity,
            req.body.operationId,
        );
        await logPatientAudit(connection, req, 'patient.create', id, {
            fields: PATIENT_FIELDS,
            operationId: req.body.operationId,
        });
        await connection.execute(
            `INSERT INTO sync_operations (operation_id, payload_hash, patient_id, operation_type)
             VALUES (?, ?, ?, 'ADD')`,
            [req.body.operationId, hash, id]
        );
        await connection.commit();

        if (req.headers.accept?.includes('application/json')) {
            return res.json({ success: true, message: 'Patient added successfully', id });
        }
        res.redirect(`/patients/${encodeURIComponent(id)}`);
    } catch (err) {
        await connection.rollback();
        if (err.code === 'ER_DUP_ENTRY') {
            return respondError(req, res, 409, 'A patient with this ID already exists.', '/patients?error=add_failed');
        }
        logger.error('patient.create.failed', {
            requestId: req.requestId,
            errorCode: err.code || 'DATABASE_ERROR',
        });
        return respondError(req, res, 500, 'Failed to add patient.', '/patients?error=add_failed');
    } finally {
        connection.release();
    }
});

router.post('/delete/:id', async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, error: 'A valid patient UUID is required.' });
    if (!isAdmin(req)) return respondError(req, res, 403, 'Administrator access is required.', '/patients?error=forbidden');
    const expectedVersion = Number(req.body.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        return res.status(409).json({ success: false, error: 'Patient version is required' });
    }
    if (!isUuid(req.body.operationId)) {
        return res.status(400).json({ success: false, error: 'A valid operation UUID is required.' });
    }
    const hash = operationPayloadHash('DELETE', 'patients', { id: req.params.id, version: expectedVersion });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [priorOperations] = await connection.execute(
            'SELECT payload_hash FROM sync_operations WHERE operation_id = ?',
            [req.body.operationId]
        );
        if (priorOperations.length) {
            await connection.rollback();
            if (priorOperations[0].payload_hash !== hash) {
                return res.status(409).json({ success: false, error: 'Operation ID was already used for different patient data.' });
            }
            return res.json({ success: true });
        }
        const deleted = await patientRepository.updateIfVersion(connection, {
            id: req.params.id,
            expectedVersion,
            deleted: true,
            actorId: req.session.user.id,
        });
        if (!deleted) {
            await connection.rollback();
            return res.status(409).json({ success: false, conflict: true, error: 'Patient was changed elsewhere' });
        }
        await logActivity(
            connection,
            req.params.id,
            req.session.user.id,
            'deleted',
            activityDetails('deleted', [], req, req.body.operationId),
            req.body.operationId,
        );
        await logPatientAudit(connection, req, 'patient.delete', req.params.id, {
            operationId: req.body.operationId,
        });
        await connection.execute(
            `INSERT INTO sync_operations (operation_id, payload_hash, patient_id, operation_type)
             VALUES (?, ?, ?, 'DELETE')`,
            [req.body.operationId, hash, req.params.id]
        );
        await connection.commit();
        if (req.headers.accept?.includes('application/json')) return res.json({ success: true });
        res.redirect('/patients');
    } catch (err) {
        await connection.rollback();
        logger.error('patient.delete.failed', {
            requestId: req.requestId,
            errorCode: err.code || 'DATABASE_ERROR',
        });
        return respondError(req, res, 500, 'Unable to delete patient.', '/patients?error=delete_failed');
    } finally {
        connection.release();
    }
});

router.post('/restore/:id', async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, error: 'A valid patient UUID is required.' });
    if (!isAdmin(req)) return respondError(req, res, 403, 'Administrator access is required.', '/patients?error=forbidden');
    const expectedVersion = Number(req.body.version);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        return res.status(409).json({ success: false, error: 'Patient version is required.' });
    }
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const restored = await patientRepository.restoreIfVersion(connection, {
            id: req.params.id,
            expectedVersion,
            actorId: req.session.user.id,
        });
        if (!restored) {
            await connection.rollback();
            return res.status(409).json({ success: false, conflict: true, error: 'Patient was changed elsewhere or is no longer deleted.' });
        }
        await logActivity(
            connection,
            req.params.id,
            req.session.user.id,
            'restored',
            activityDetails('restored', [], req),
        );
        await logPatientAudit(connection, req, 'patient.restore', req.params.id);
        await connection.commit();
        if (req.headers.accept?.includes('application/json')) return res.json({ success: true });
        if (req.body.profileReturn === 'true') {
            return res.redirect(patientProfilePath(req.params.id, req.body.returnTo, { updated: '1' }));
        }
        const returnTo = patientListReturnPath(req.body.returnTo);
        res.redirect(returnTo === '/patients' ? '/patients?status=deleted' : returnTo);
    } catch (err) {
        await connection.rollback();
        logger.error('patient.restore.failed', {
            requestId: req.requestId,
            errorCode: err.code || 'DATABASE_ERROR',
        });
        const returnTo = patientListReturnPath(req.body.returnTo);
        return respondError(req, res, 500, 'Unable to restore patient.', `${returnTo}${returnTo.includes('?') ? '&' : '?'}error=restore_failed`);
    } finally {
        connection.release();
    }
});

router.post('/visits/add/:id', async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, error: 'A valid patient UUID is required.' });
    if (!isClinicalStaff(req)) return respondError(req, res, 403, 'Staff access is required.', '/patients?error=forbidden');
    const normalized = normalizeVisitInput(req.body);
    if (normalized.error) {
        return respondError(req, res, 400, normalized.error, patientProfilePath(req.params.id, req.body.returnTo, { error: 'invalid_visit' }));
    }
    const visit = normalized.value;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const patient = await patientRepository.findById(connection, req.params.id, { forUpdate: true });
        if (!patient || patient.is_deleted) {
            await connection.rollback();
            return res.status(404).send('Patient not found.');
        }
        const [insert] = await connection.execute(
            `INSERT INTO patient_visits
             (patient_id, visit_date, visit_type, attending_staff_id, created_by,
              updated_by, status, reason, notes, assessment, diagnosis, treatment_plan)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                patient.id,
                visit.visitDate,
                visit.visit_type,
                req.session.user.id,
                req.session.user.id,
                req.session.user.id,
                visit.status,
                visit.reason || null,
                visit.notes || null,
                visit.assessment || null,
                visit.diagnosis || null,
                visit.treatment_plan || null,
            ],
        );
        await addVisitVitals(connection, insert.insertId, req.session.user.id, visit.vitals);
        await recordVisitEvent(connection, req, {
            visitId: insert.insertId,
            patientId: patient.id,
            eventType: 'created',
            details: {
                after: {
                    visitDate: visit.visitDate,
                    visitType: visit.visit_type,
                    attendingStaffId: req.session.user.id,
                    status: visit.status,
                    reason: visit.reason,
                    notes: visit.notes,
                    assessment: visit.assessment,
                    diagnosis: visit.diagnosis,
                    treatmentPlan: visit.treatment_plan,
                    vitals: visit.vitals,
                },
            },
        });
        await logActivity(
            connection,
            patient.id,
            req.session.user.id,
            'visit recorded',
            activityDetails('visit recorded', [], req),
        );
        await connection.commit();
        if (req.headers.accept?.includes('application/json')) return res.json({ success: true, visitId: insert.insertId });
        res.redirect(patientProfilePath(req.params.id, req.body.returnTo));
    } catch (err) {
        await connection.rollback();
        logger.error('patient.visit.create.failed', {
            requestId: req.requestId,
            errorCode: err.code || 'DATABASE_ERROR',
        });
        return respondError(req, res, 500, 'Unable to record visit.', patientProfilePath(req.params.id, req.body.returnTo, { error: 'visit_failed' }));
    } finally {
        connection.release();
    }
});

router.post('/visits/:visitId/edit', async (req, res) => {
    if (!isVisitId(req.params.visitId) || !isUuid(req.body.patient_id)) {
        return res.status(400).json({ success: false, error: 'A valid visit ID is required.' });
    }
    if (!isClinicalStaff(req)) return respondError(req, res, 403, 'Staff access is required.', '/patients?error=forbidden');
    const normalized = normalizeVisitInput(req.body);
    if (normalized.error) {
        return respondError(req, res, 400, normalized.error, patientProfilePath(req.body.patient_id, req.body.returnTo, { error: 'invalid_visit' }));
    }
    const visit = normalized.value;
    const expectedVersion = Number(req.body.version);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        return res.status(409).json({ success: false, error: 'Visit version is required.' });
    }
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [rows] = await connection.execute(
            `SELECT v.*, p.is_deleted
             FROM patient_visits v
             INNER JOIN patients p ON p.id = v.patient_id
             WHERE v.id = ? AND v.patient_id = ? FOR UPDATE`,
            [req.params.visitId, req.body.patient_id],
        );
        const before = rows[0];
        if (!before || before.is_deleted) {
            await connection.rollback();
            return res.status(404).send('Visit not found.');
        }
        const patientId = String(before.patient_id);
        const previous = {
            visitDate: String(before.visit_date).slice(0, 10),
            visitType: before.visit_type || '',
            attendingStaffId: before.attending_staff_id || null,
            status: before.status || 'completed',
            reason: before.reason || '',
            notes: before.notes || '',
            assessment: before.assessment || '',
            diagnosis: before.diagnosis || '',
            treatmentPlan: before.treatment_plan || '',
        };
        const next = {
            visitDate: visit.visitDate,
            visitType: visit.visit_type,
            attendingStaffId: req.session.user.id,
            status: visit.status,
            reason: visit.reason,
            notes: visit.notes,
            assessment: visit.assessment,
            diagnosis: visit.diagnosis,
            treatmentPlan: visit.treatment_plan,
        };
        const [update] = await connection.execute(
            `UPDATE patient_visits
             SET visit_date = ?, visit_type = ?, attending_staff_id = ?,
                 updated_by = ?, status = ?, reason = ?, notes = ?,
                 assessment = ?, diagnosis = ?, treatment_plan = ?,
                 version = version + 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND version = ?`,
            [
                visit.visitDate,
                visit.visit_type,
                req.session.user.id,
                req.session.user.id,
                visit.status,
                visit.reason || null,
                visit.notes || null,
                visit.assessment || null,
                visit.diagnosis || null,
                visit.treatment_plan || null,
                req.params.visitId,
                expectedVersion,
            ],
        );
        if (!update.affectedRows) {
            await connection.rollback();
            return res.status(409).json({ success: false, conflict: true, error: 'Visit was changed elsewhere.' });
        }
        await addVisitVitals(connection, req.params.visitId, req.session.user.id, visit.vitals);
        await recordVisitEvent(connection, req, {
            visitId: req.params.visitId,
            patientId,
            eventType: 'updated',
            details: { before: previous, after: { ...next, vitals: visit.vitals } },
        });
        await logActivity(
            connection,
            patientId,
            req.session.user.id,
            'visit updated',
            activityDetails('visit updated', [], req),
        );
        await connection.commit();
        if (req.headers.accept?.includes('application/json')) return res.json({ success: true });
        return res.redirect(patientProfilePath(patientId, req.body.returnTo));
    } catch (err) {
        await connection.rollback();
        logger.error('patient.visit.update.failed', {
            requestId: req.requestId,
            errorCode: err.code || 'DATABASE_ERROR',
        });
        return respondError(req, res, 500, 'Unable to update visit.', patientProfilePath(req.body.patient_id, req.body.returnTo, { error: 'visit_failed' }));
    } finally {
        connection.release();
    }
});

router.post('/notes/add/:id', async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, error: 'A valid patient UUID is required.' });
    if (!isClinicalStaff(req)) return respondError(req, res, 403, 'Staff access is required.', '/patients?error=forbidden');
    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    if (!note || note.length > 10000) {
        return respondError(req, res, 400, 'Enter a note up to 10,000 characters.', patientProfilePath(req.params.id, req.body.returnTo, { error: 'invalid_note' }));
    }
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const patient = await patientRepository.findById(connection, req.params.id, { forUpdate: true });
        if (!patient || patient.is_deleted) {
            await connection.rollback();
            return res.status(404).send('Patient not found.');
        }
        await connection.execute(
            'INSERT INTO patient_notes (patient_id, author_id, note) VALUES (?, ?, ?)',
            [patient.id, req.session.user.id, note],
        );
        await logActivity(
            connection,
            patient.id,
            req.session.user.id,
            'note added',
            activityDetails('note added', [], req),
        );
        await logPatientAudit(connection, req, 'patient.note.create', patient.id);
        await connection.commit();
        if (req.headers.accept?.includes('application/json')) return res.json({ success: true });
        res.redirect(patientProfilePath(patient.id, req.body.returnTo));
    } catch (err) {
        await connection.rollback();
        logger.error('patient.note.create.failed', {
            requestId: req.requestId,
            errorCode: err.code || 'DATABASE_ERROR',
        });
        return respondError(req, res, 500, 'Unable to add note.', patientProfilePath(req.params.id, req.body.returnTo, { error: 'note_failed' }));
    } finally {
        connection.release();
    }
});

router.post('/edit/:id', async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, error: 'A valid patient UUID is required.' });
    if (!isClinicalStaff(req)) return respondError(req, res, 403, 'Staff access is required.', '/patients?error=forbidden');
    const validation = normalizePatientData(req.body);
    if (validation.error) return respondError(req, res, 400, validation.error, patientProfilePath(req.params.id, req.body.returnTo, { error: 'invalid_patient' }));
    const { data } = validation;
    const expectedVersion = Number(req.body.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        return res.status(409).json({ success: false, error: 'Patient version is required' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const before = await patientRepository.findById(connection, req.params.id, {
            forUpdate: true,
        });
        const updated = await patientRepository.updateIfVersion(connection, {
            id: req.params.id,
            data,
            expectedVersion,
            actorId: req.session.user.id,
        });
        if (!updated) {
            await connection.rollback();
            return res.status(409).json({ success: false, conflict: true, error: 'Patient was changed elsewhere' });
        }
        const changedFields = PATIENT_FIELDS.filter((field) => {
            const beforeValue = before?.[field];
            const normalizedBefore =
                beforeValue instanceof Date
                    ? beforeValue.toISOString().slice(0, 10)
                    : String(beforeValue ?? '').trim();
            return normalizedBefore !== data[field];
        });
        const activity = activityDetails('updated', changedFields, req);
        await logActivity(
            connection,
            req.params.id,
            req.session.user.id,
            'updated',
            activity,
        );
        await logPatientAudit(connection, req, 'patient.update', req.params.id, {
            fields: changedFields,
        });
        await connection.commit();
        if (req.headers.accept?.includes('application/json')) return res.json({ success: true });
        res.redirect(patientProfilePath(req.params.id, req.body.returnTo, { updated: '1' }));
    } catch (err) {
        await connection.rollback();
        logger.error('patient.update.failed', {
            requestId: req.requestId,
            errorCode: err.code || 'DATABASE_ERROR',
        });
        return respondError(req, res, 500, 'Unable to update patient.', patientProfilePath(req.params.id, req.body.returnTo, { error: 'update_failed' }));
    } finally {
        connection.release();
    }
});

router.get('/:id', async (req, res) => {
    const returnTo = patientListReturnPath(req.query.returnTo);
    const requestedVisitPage = parsePositiveInteger(req.query.visitsPage, 1, 1_000_000);
    const visitPageSize = 20;
    let visitPage = requestedVisitPage;
    let visitPages = 1;
    let visitTotal = 0;
    let visitsError = false;
    let visits = [];
    let latestVitals = null;
    if (!isUuid(req.params.id)) {
        return res.status(400).render('patient-profile', {
            user: req.session.user,
            patient: null,
            appointments: [],
            staff: [],
            appointmentOperationId: crypto.randomUUID(),
            visits,
            visitsError,
            visitPagination: { page: visitPage, pages: visitPages, total: visitTotal },
            latestVitals,
            notes: [],
            activity: [],
            completenessWarnings: [],
            generatedAt: new Date(),
            returnTo,
            error: 'A valid patient ID is required.',
        });
    }
    try {
        const patient = await patientRepository.findById(pool, req.params.id);
        if (!patient) return res.status(404).render('patient-profile', {
            user: req.session.user,
            patient: null,
            appointments: [],
            staff: [],
            appointmentOperationId: crypto.randomUUID(),
            visits,
            visitsError,
            visitPagination: { page: visitPage, pages: visitPages, total: visitTotal },
            latestVitals,
            notes: [],
            activity: [],
            completenessWarnings: [],
            generatedAt: new Date(),
            returnTo,
            error: 'Patient not found.',
        });
        await recordAudit({ actorId: req.session.user.id, action: 'patient.access', targetId: patient.id });
        if (patient.is_deleted && !isAdmin(req)) {
            return res.status(404).render('patient-profile', {
                user: req.session.user,
                patient: null,
                appointments: [],
                staff: [],
                appointmentOperationId: crypto.randomUUID(),
                visits,
                visitsError,
                visitPagination: { page: visitPage, pages: visitPages, total: visitTotal },
                latestVitals,
                notes: [],
                activity: [],
                completenessWarnings: [],
                generatedAt: new Date(),
                returnTo,
                error: 'Patient not found.',
            });
        }
        try {
        const [[visitCount]] = await pool.execute(
            'SELECT COUNT(*) AS total FROM patient_visits WHERE patient_id = ?',
            [patient.id],
        );
        visitTotal = Number(visitCount.total);
        visitPages = Math.max(1, Math.ceil(visitTotal / visitPageSize));
        visitPage = Math.min(visitPage, visitPages);
        const visitOffset = (visitPage - 1) * visitPageSize;
        const [visitRows] = await pool.query(
            `SELECT v.id, v.patient_id, v.visit_date, v.visit_type,
                    v.attending_staff_id, attending.username AS attending_name,
                    v.created_by, creator.username AS created_by_name,
                    v.updated_by, editor.username AS updated_by_name,
                    v.status, v.reason, v.notes, v.assessment, v.diagnosis,
                    v.treatment_plan, v.version, v.created_at, v.updated_at
             FROM patient_visits v
             LEFT JOIN users attending ON attending.id = v.attending_staff_id
             LEFT JOIN users creator ON creator.id = v.created_by
             LEFT JOIN users editor ON editor.id = v.updated_by
             WHERE v.patient_id = ?
             ORDER BY v.visit_date DESC, v.created_at DESC, v.id DESC
             LIMIT ? OFFSET ?`,
            [patient.id, visitPageSize, visitOffset],
        );
        visits = visitRows.map((visit) => ({
            ...visit,
            id: String(visit.id),
            vitals: [],
            events: [],
        }));
        if (visits.length) {
            const visitIds = visits.map((visit) => visit.id);
            const placeholders = visitIds.map(() => '?').join(', ');
            const [[vitalRows], [eventRows], [latestRows]] = await Promise.all([
                pool.execute(
                    `SELECT v.id, v.visit_id, v.recorded_by,
                            author.username AS author_name, v.recorded_at,
                            v.systolic_mmhg, v.diastolic_mmhg, v.pulse_bpm,
                            v.temperature_celsius, v.respiratory_rate_per_minute,
                            v.oxygen_saturation_percent, v.height_cm, v.weight_kg
                     FROM patient_visit_vitals v
                     LEFT JOIN users author ON author.id = v.recorded_by
                     WHERE v.visit_id IN (${placeholders})
                     ORDER BY v.recorded_at DESC, v.id DESC`,
                    visitIds,
                ),
                pool.execute(
                    `SELECT e.visit_id, e.actor_id, author.username AS actor_name,
                            e.event_type, e.details, e.created_at
                     FROM patient_visit_events e
                     LEFT JOIN users author ON author.id = e.actor_id
                     WHERE e.visit_id IN (${placeholders})
                     ORDER BY e.created_at DESC, e.id DESC`,
                    visitIds,
                ),
                pool.execute(
                    `SELECT v.id, v.visit_id, pvisit.visit_date, v.recorded_at,
                            v.systolic_mmhg, v.diastolic_mmhg, v.pulse_bpm,
                            v.temperature_celsius, v.respiratory_rate_per_minute,
                            v.oxygen_saturation_percent, v.height_cm, v.weight_kg
                     FROM patient_visit_vitals v
                     INNER JOIN patient_visits pvisit ON pvisit.id = v.visit_id
                     WHERE pvisit.patient_id = ?
                     ORDER BY v.recorded_at DESC, v.id DESC LIMIT 1`,
                    [patient.id],
                ),
            ]);
            const visitsById = new Map(visits.map((visit) => [visit.id, visit]));
            for (const vital of vitalRows) {
                visitsById.get(String(vital.visit_id))?.vitals.push(vital);
            }
            for (const event of eventRows) {
                try {
                    event.details = JSON.parse(event.details);
                } catch {
                    logger.error('patient.visit.history.invalid', {
                        requestId: req.requestId,
                        errorCode: 'INVALID_HISTORY_JSON',
                    });
                    event.details = null;
                }
                visitsById.get(String(event.visit_id))?.events.push(event);
            }
            latestVitals = latestRows[0] || null;
        }
        } catch (visitError) {
            visitsError = true;
            visits = [];
            logger.error('patient.visits.list.failed', {
                requestId: req.requestId,
                errorCode: visitError.code || 'DATABASE_ERROR',
            });
        }
        const appointmentScope = isAdmin(req)
            ? ''
            : ' AND a.assigned_staff_id = ?';
        const appointmentParams = isAdmin(req)
            ? [patient.id]
            : [patient.id, req.session.user.id];
        const [
            [appointments],
            [appointmentStaff],
            [notes],
            [activityRows],
        ] = await Promise.all([
            pool.execute(
                `SELECT a.id, a.patient_id, a.assigned_staff_id,
                        DATE_FORMAT(a.start_at, '%Y-%m-%d %H:%i:%s') AS start_at_utc,
                        a.duration_minutes, a.reason, a.status, a.version,
                        u.username AS staff_name
                 FROM appointments a
                 INNER JOIN users u ON u.id = a.assigned_staff_id
                 WHERE a.patient_id = ?${appointmentScope}
                 ORDER BY a.start_at DESC, a.id DESC LIMIT 100`,
                appointmentParams,
            ),
            isAdmin(req)
                ? pool.execute(
                    `SELECT id, username FROM users
                     WHERE is_active = TRUE AND is_deleted = FALSE
                       AND role IN ('admin', 'staff')
                     ORDER BY username, id`,
                )
                : Promise.resolve([[], []]),
            pool.execute(
                `SELECT n.id, n.note, n.created_at, u.username AS author_name
                 FROM patient_notes n
                 INNER JOIN users u ON u.id = n.author_id
                 WHERE n.patient_id = ? ORDER BY n.created_at DESC, n.id DESC`,
                [patient.id],
            ),
            pool.execute(
                `SELECT a.action, a.details, a.operation_id, a.created_at, u.username
                 FROM patient_activity a
                 LEFT JOIN users u ON u.id = a.user_id
                 WHERE a.patient_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 50`,
                [patient.id],
            ),
        ]);
        const appointmentIds = appointments.map((appointment) => appointment.id);
        let appointmentEvents = [];
        if (appointmentIds.length) {
            const [events] = await pool.execute(
                `SELECT e.appointment_id, e.event_type, e.details, e.created_at,
                        u.username AS actor_name
                 FROM appointment_events e
                 LEFT JOIN users u ON u.id = e.actor_id
                 WHERE e.appointment_id IN (${appointmentIds.map(() => '?').join(', ')})
                 ORDER BY e.created_at DESC, e.id DESC`,
                appointmentIds,
            );
            appointmentEvents = events;
        }
        const eventsByAppointment = new Map();
        for (const event of appointmentEvents) {
            const list = eventsByAppointment.get(event.appointment_id) || [];
            list.push({
                ...event,
                eventLabel: {
                    scheduled: 'Scheduled',
                    rescheduled: 'Rescheduled',
                    cancelled: 'Cancelled',
                    completed: 'Completed',
                    missed: 'Marked missed',
                }[event.event_type] || 'Updated',
            });
            eventsByAppointment.set(event.appointment_id, list);
        }
        const profileAppointments = appointments.map((appointment) => ({
            ...appointment,
            events: eventsByAppointment.get(appointment.id) || [],
            rescheduleOperationId: crypto.randomUUID(),
            cancelOperationId: crypto.randomUUID(),
        }));
        const activity = activityRows.map((item) => {
            let details = item.details;
            let actorRole = null;
            let source = null;
            let changedFields = [];
            if (typeof details === 'string' && details.startsWith('{')) {
                try {
                    const parsed = JSON.parse(details);
                    actorRole = ['admin', 'staff'].includes(parsed.actorRole)
                        ? parsed.actorRole
                        : null;
                    source = parsed.source === 'sync' ? 'sync' : null;
                    changedFields = Array.isArray(parsed.fields)
                        ? parsed.fields.filter((field) => PATIENT_FIELDS.includes(field))
                        : [];
                    details = changedFields.length
                        ? `Changed fields: ${changedFields.map((field) => field.replaceAll('_', ' ')).join(', ')}`
                        : null;
                } catch {
                    details = item.details;
                }
            }
            return { ...item, details, actorRole, source, changedFields };
        });
        res.render('patient-profile', {
            user: req.session.user,
            patient,
            appointments: profileAppointments,
            staff: appointmentStaff,
            appointmentOperationId: crypto.randomUUID(),
            visits,
            visitsError,
            visitPagination: { page: visitPage, pages: visitPages, total: visitTotal, pageSize: visitPageSize },
            latestVitals,
            notes,
            activity,
            completenessWarnings: getPatientCompletenessWarnings(patient),
            generatedAt: new Date(),
            query: req.query,
            returnTo,
            error: {
                invalid_patient: 'Check the patient details and date fields.',
                update_failed: 'Patient changes could not be saved.',
                invalid_visit: 'Check the visit date and details.',
                visit_failed: 'The visit could not be recorded.',
                invalid_note: 'Enter a note up to 10,000 characters.',
                note_failed: 'The note could not be added.',
                appointment_conflict: 'That staff member already has an overlapping appointment. Choose another time.',
                appointment_invalid: 'Check the appointment details and try again.',
                appointment_failed: 'The appointment could not be saved. Try again.',
                appointment_unavailable: 'The patient or assigned staff member is unavailable.',
                appointment_forbidden: 'You do not have permission to change this appointment.',
                appointment_stale: 'This appointment changed in another request. Reload the profile and try again.',
            }[req.query.error] || null,
        });
    } catch (err) {
        logger.error('patient.profile.failed', {
            requestId: req.requestId,
            errorCode: err.code || 'DATABASE_ERROR',
        });
        res.status(500).render('patient-profile', {
            user: req.session.user,
            patient: null,
            appointments: [],
            staff: [],
            appointmentOperationId: crypto.randomUUID(),
            visits,
            visitsError: true,
            visitPagination: { page: visitPage, pages: visitPages, total: visitTotal, pageSize: visitPageSize },
            latestVitals: null,
            notes: [],
            activity: [],
            completenessWarnings: [],
            generatedAt: new Date(),
            returnTo,
            error: 'Patient profile could not be loaded. Please try again.',
        });
    }
});

module.exports = router;
