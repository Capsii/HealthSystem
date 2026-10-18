const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { requireRole, sensitiveCsrf, csrfToken, recordAudit } = require('../middleware/auth');
const { validatePassword } = require('../staff_security');
const { BACKUP_DATASETS, BACKUP_FORMAT, BACKUP_VERSION, validateBackupPayload } = require('../backup_format');
const {
    MAX_IMPORT_BYTES,
    csvRow,
    validatePatientCsv,
} = require('../patient_csv');
const {
    PATIENT_FIELDS,
    isDateOnly,
    isUuid,
    normalizePatientData,
} = require('../patient_validation');
const { writeAuditEvent } = require('../audit');

const router = express.Router();
function boundedTextBody(parser, limitMessage) {
    return (req, res, next) => parser(req, res, (error) => {
        if (!error) return next();
        const status = error.status === 413 ? 413 : 400;
        return res.status(status).json({ error: status === 413 ? limitMessage : 'The uploaded file could not be read.' });
    });
}
const CSV_BODY = boundedTextBody(
    express.text({ type: ['text/plain', 'text/csv'], limit: MAX_IMPORT_BYTES }),
    `CSV file exceeds the ${Math.ceil(MAX_IMPORT_BYTES / (1024 * 1024))} MB upload limit.`
);
const BACKUP_BODY = boundedTextBody(
    express.text({ type: ['text/plain'], limit: '50mb' }),
    'Backup file exceeds the 50 MB upload limit.'
);
const ID_CHUNK_SIZE = 500;
const EXPORT_BATCH_SIZE = 500;

const backupTables = {
    patients: {
        table: 'patients',
        key: 'id',
        columns: ['id', ...PATIENT_FIELDS, 'is_deleted', 'version', 'created_at', 'updated_at', 'last_modified_by'],
    },
    patientVisits: {
        table: 'patient_visits',
        key: 'id',
        columns: [
            'id', 'patient_id', 'visit_date', 'visit_type', 'attending_staff_id',
            'created_by', 'updated_by', 'status', 'reason', 'notes', 'assessment',
            'diagnosis', 'treatment_plan', 'version', 'created_at', 'updated_at',
        ],
    },
    patientVisitVitals: {
        table: 'patient_visit_vitals',
        key: 'id',
        columns: [
            'id', 'visit_id', 'recorded_by', 'recorded_at', 'systolic_mmhg',
            'diastolic_mmhg', 'pulse_bpm', 'temperature_celsius',
            'respiratory_rate_per_minute', 'oxygen_saturation_percent',
            'height_cm', 'weight_kg',
        ],
    },
    patientVisitEvents: {
        table: 'patient_visit_events',
        key: 'id',
        columns: [
            'id', 'visit_id', 'patient_id', 'actor_id', 'event_type',
            'details', 'created_at',
        ],
    },
    patientActivity: {
        table: 'patient_activity',
        key: 'id',
        columns: ['id', 'patient_id', 'user_id', 'action', 'details', 'operation_id', 'created_at'],
    },
    patientNotes: {
        table: 'patient_notes',
        key: 'id',
        columns: ['id', 'patient_id', 'author_id', 'note', 'created_at'],
    },
    appointments: {
        table: 'appointments',
        key: 'id',
        columns: [
            'id',
            'patient_id',
            'assigned_staff_id',
            'created_by',
            'start_at',
            'duration_minutes',
            'reason',
            'status',
            'version',
            'created_at',
            'updated_at',
        ],
    },
    appointmentEvents: {
        table: 'appointment_events',
        key: 'id',
        columns: [
            'id',
            'appointment_id',
            'actor_id',
            'event_type',
            'operation_id',
            'payload_hash',
            'details',
            'created_at',
        ],
    },
    users: {
        table: 'users',
        key: 'id',
        columns: ['id', 'username', 'username_normalized', 'role', 'is_active', 'is_deleted',
            'created_by', 'created_at', 'last_login', 'session_version'],
    },
    securityAuditLog: {
        table: 'security_audit_log',
        key: 'id',
        columns: [
            'id',
            'actor_id',
            'actor_role',
            'action',
            'target_id',
            'entity_type',
            'entity_id',
            'outcome',
            'request_id',
            'operation_id',
            'details',
            'failure_category',
            'created_at',
        ],
    },
    syncOperations: {
        table: 'sync_operations',
        key: 'operation_id',
        columns: ['operation_id', 'payload_hash', 'patient_id', 'operation_type', 'created_at'],
    },
    syncLogs: {
        table: 'sync_logs',
        key: 'id',
        columns: ['id', 'user_id', 'action_type', 'success', 'conflict_detected', 'operation_count', 'synced_at'],
    },
};

function backupFilename(timestamp) {
    return `healthsys-server-backup-${timestamp.replace(/[:.]/g, '-')}.json`;
}

function parseUploadedJson(req) {
    if (typeof req.body !== 'string' || !req.body.trim()) {
        return { error: 'Upload a valid HealthSys backup JSON file.' };
    }
    try {
        return { value: JSON.parse(req.body.charCodeAt(0) === 0xFEFF ? req.body.slice(1) : req.body) };
    } catch {
        return { error: 'Backup file is not valid JSON.' };
    }
}

async function getDuplicatePatientIds(connection, ids) {
    const duplicates = new Set();
    for (let index = 0; index < ids.length; index += ID_CHUNK_SIZE) {
        const chunk = ids.slice(index, index + ID_CHUNK_SIZE);
        if (!chunk.length) continue;
        const placeholders = chunk.map(() => '?').join(', ');
        const [rows] = await connection.execute(
            `SELECT id FROM patients WHERE id IN (${placeholders})`,
            chunk
        );
        rows.forEach((row) => duplicates.add(String(row.id).toLowerCase()));
    }
    return duplicates;
}

async function getExistingPhoneMatches(connection, rows) {
    const phones = [...new Set(rows.map((row) => row.data.phone))];
    const matches = new Map();
    for (let index = 0; index < phones.length; index += ID_CHUNK_SIZE) {
        const chunk = phones.slice(index, index + ID_CHUNK_SIZE);
        if (!chunk.length) continue;
        const placeholders = chunk.map(() => '?').join(', ');
        const [records] = await connection.execute(
            `SELECT id, phone FROM patients WHERE phone IN (${placeholders})`,
            chunk,
        );
        for (const record of records) {
            const key = String(record.phone || '').toLowerCase();
            if (!matches.has(key)) matches.set(key, []);
            matches.get(key).push(String(record.id));
        }
    }
    return matches;
}

async function prepareCsvImport(connection, parsed) {
    const ids = parsed.validRows.map((row) => row.id);
    const existingIds = await getDuplicatePatientIds(connection, ids);
    const existingPhones = await getExistingPhoneMatches(connection, parsed.validRows);
    const filePhones = new Set();
    const validRows = [];
    const invalidRows = [...parsed.invalidRows];
    let duplicates = parsed.invalidRows.filter((row) =>
        row.errors.some((error) => error.column === 'id' && /duplicated/.test(error.message)),
    ).length;
    let potentialMatches = 0;
    for (const row of parsed.validRows) {
        if (existingIds.has(row.id.toLowerCase())) {
            invalidRows.push({
                row: row.row,
                id: row.id,
                errors: [{ column: 'id', message: 'Patient ID already exists in HealthSys.' }],
            });
            duplicates++;
        } else if (existingPhones.has(row.data.phone.toLowerCase())) {
            const matchedIds = existingPhones.get(row.data.phone.toLowerCase());
            invalidRows.push({
                row: row.row,
                errors: [{
                    column: 'phone',
                    message: `Phone number matches ${matchedIds.length} existing patient record(s); review this possible match before importing.`,
                }],
                matches: matchedIds.slice(0, 3),
                matchCount: matchedIds.length,
            });
            potentialMatches++;
        } else if (filePhones.has(row.data.phone.toLowerCase())) {
            invalidRows.push({
                row: row.row,
                errors: [{
                    column: 'phone',
                    message: 'Phone number is also used by another row in this file; review whether these records are duplicates.',
                }],
            });
            potentialMatches++;
        } else {
            filePhones.add(row.data.phone.toLowerCase());
            validRows.push(row);
        }
    }
    invalidRows.sort((left, right) => left.row - right.row);
    return {
        validRows,
        invalidRows,
        skipped: parsed.skipped,
        counts: {
            valid: validRows.length,
            rejected: invalidRows.length,
            skipped: parsed.skipped,
            duplicates,
            potentialMatches,
        },
    };
}

async function writeJsonArray(res, connection, definition, transform = (row) => row) {
    await writeResponse(res, '[');
    let lastKey = null;
    let firstRow = true;
    while (true) {
        const cursorCondition = lastKey === null ? '' : `WHERE ${definition.key} > ?`;
        const [rows] = await connection.execute(
            `SELECT ${definition.columns.join(', ')} FROM ${definition.table}
             ${cursorCondition} ORDER BY ${definition.key} ASC LIMIT ${EXPORT_BATCH_SIZE}`,
            lastKey === null ? [] : [lastKey]
        );
        if (!rows.length) break;
        for (const row of rows) {
            if (!firstRow) await writeResponse(res, ',');
            await writeResponse(res, JSON.stringify(transform(row)));
            firstRow = false;
        }
        lastKey = rows[rows.length - 1][definition.key];
    }
    await writeResponse(res, ']');
}

function writeResponse(res, chunk) {
    if (res.write(chunk)) return Promise.resolve();
    return new Promise((resolve, reject) => {
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
            reject(new Error('Backup download was interrupted.'));
        };
        res.once('drain', onDrain);
        res.once('error', onError);
        res.once('close', onClose);
    });
}

async function readBackup(req, res) {
    if (req.body?.confirm !== 'yes') {
        await recordAudit({
            actorId: req.session.user.id,
            action: 'backup.server.create',
            outcome: 'failure',
        });
        return res.status(400).send('Confirm the sensitive backup download before continuing.');
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const createdAt = new Date().toISOString();
        await writeAuditEvent(connection, {
            actorId: req.session.user.id,
            actorRole: req.session.user.role,
            action: 'backup.server.create',
            entityType: 'backup',
            outcome: 'success',
            requestId: req.requestId || null,
            details: { datasetCount: BACKUP_DATASETS.length },
        });
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="${backupFilename(createdAt)}"`,
            'X-Content-Type-Options': 'nosniff',
        });
        const backupPrefix = JSON.stringify({
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            schemaVersion: 1,
            createdAt,
            data: {},
        });
        await writeResponse(res, backupPrefix.slice(0, -2));

        for (const dataset of BACKUP_DATASETS) {
            const definition = backupTables[dataset];
            await writeResponse(res, `${JSON.stringify(dataset)}:`);
            await writeJsonArray(res, connection, definition);
            if (dataset !== BACKUP_DATASETS[BACKUP_DATASETS.length - 1]) {
                await writeResponse(res, ',');
            }
        }
        await writeResponse(res, '}}');
        await connection.commit();
        connection.release();
        connection = null;
        return res.end();
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Could not roll back backup snapshot:', rollbackError.code || 'DATABASE_ERROR');
            }
            connection.release();
            connection = null;
        }
        await recordAudit({
            actorId: req.session.user.id,
            action: 'backup.server.create',
            outcome: 'failure',
        });
        console.error('Server backup failed:', error.code || 'BACKUP_ERROR');
        if (!res.headersSent) return res.status(500).send('Server backup failed. Check the database and try again.');
        return res.destroy();
    } finally {
        if (connection) connection.release();
    }
}

async function isFreshRestoreTarget(connection, actorId) {
    const [[accountCount]] = await connection.execute('SELECT COUNT(*) AS total FROM users');
    const [[actor]] = await connection.execute(
        'SELECT id, role, is_active, is_deleted FROM users WHERE id = ? FOR UPDATE',
        [actorId]
    );
    if (Number(accountCount.total) !== 1 || !actor || actor.role !== 'admin' ||
        !actor.is_active || actor.is_deleted) {
        return false;
    }
    for (const table of [
        'patients',
        'patient_visits',
        'patient_visit_vitals',
        'patient_visit_events',
        'patient_activity',
        'patient_notes',
        'appointments',
        'appointment_events',
        'sync_operations',
        'sync_logs',
    ]) {
        const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM ${table}`);
        if (Number(count.total) !== 0) return false;
    }
    return true;
}

function mysqlTimestamp(value) {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) return text;
    return new Date(text).toISOString().replace('T', ' ').replace(/Z$/, '').slice(0, 19);
}

function normalizePatientForRestore(patient) {
    const normalized = normalizePatientData(patient);
    if (normalized.error) throw new Error('Backup patient data changed after validation.');
    return normalized.data;
}

async function insertBackup(connection, backup, bootstrapAdminPassword) {
    const users = backup.data.users;
    const restoreSecret = crypto.randomBytes(32).toString('hex');
    const unavailablePasswordHash = await bcrypt.hash(restoreSecret, 10);
    const bootstrapAdmin = users.find((user) =>
        user.role === 'admin' && user.is_active && !user.is_deleted
    );
    const bootstrapPasswordHash = await bcrypt.hash(bootstrapAdminPassword, 10);

    await connection.execute('DELETE FROM users');
    for (const user of users) {
        const passwordHash = user.id === bootstrapAdmin.id
            ? bootstrapPasswordHash
            : unavailablePasswordHash;
        await connection.execute(
            `INSERT INTO users
             (id, username, username_normalized, password_hash, role, is_active, is_deleted,
              created_by, created_at, last_login, session_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                user.id,
                user.username,
                user.username_normalized,
                passwordHash,
                user.role,
                Boolean(user.is_active),
                Boolean(user.is_deleted),
                user.created_by || null,
                mysqlTimestamp(user.created_at),
                mysqlTimestamp(user.last_login),
                Number(user.session_version) + 1,
            ]
        );
    }

    for (const patient of backup.data.patients) {
        const patientData = normalizePatientForRestore(patient);
        await connection.execute(
            `INSERT INTO patients
             (id, full_name, date_of_birth, gender, phone, address,
              emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
              allergies, medical_history, medications, is_deleted, version, created_at, updated_at,
              last_modified_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                patient.id,
                ...PATIENT_FIELDS.map((field) => patientData[field]),
                Boolean(patient.is_deleted),
                Number(patient.version),
                mysqlTimestamp(patient.created_at),
                mysqlTimestamp(patient.updated_at),
                patient.last_modified_by || null,
            ]
        );
    }

    for (const visit of backup.data.patientVisits) {
        await connection.execute(
            `INSERT INTO patient_visits
             (id, patient_id, visit_date, visit_type, attending_staff_id, created_by,
              updated_by, status, reason, notes, assessment, diagnosis, treatment_plan,
              version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [visit.id, visit.patient_id, String(visit.visit_date).slice(0, 10),
                visit.visit_type || '', visit.attending_staff_id || null,
                visit.created_by || null, visit.updated_by || null,
                visit.status || 'completed', visit.reason || null, visit.notes || null,
                visit.assessment || null, visit.diagnosis || null,
                visit.treatment_plan || null, Number(visit.version || 1),
                mysqlTimestamp(visit.created_at), mysqlTimestamp(visit.updated_at || visit.created_at)]
        );
    }

    for (const vital of backup.data.patientVisitVitals || []) {
        await connection.execute(
            `INSERT INTO patient_visit_vitals
             (id, visit_id, recorded_by, recorded_at, systolic_mmhg, diastolic_mmhg,
              pulse_bpm, temperature_celsius, respiratory_rate_per_minute,
              oxygen_saturation_percent, height_cm, weight_kg)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                vital.id, vital.visit_id, vital.recorded_by,
                mysqlTimestamp(vital.recorded_at), vital.systolic_mmhg,
                vital.diastolic_mmhg, vital.pulse_bpm, vital.temperature_celsius,
                vital.respiratory_rate_per_minute, vital.oxygen_saturation_percent,
                vital.height_cm, vital.weight_kg,
            ],
        );
    }

    for (const event of backup.data.patientVisitEvents || []) {
        await connection.execute(
            `INSERT INTO patient_visit_events
             (id, visit_id, patient_id, actor_id, event_type, details, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                event.id, event.visit_id, event.patient_id, event.actor_id || null,
                event.event_type, event.details, mysqlTimestamp(event.created_at),
            ],
        );
    }

    for (const appointment of backup.data.appointments || []) {
        await connection.execute(
            `INSERT INTO appointments
             (id, patient_id, assigned_staff_id, created_by, start_at,
              duration_minutes, reason, status, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                appointment.id,
                appointment.patient_id,
                appointment.assigned_staff_id,
                appointment.created_by,
                mysqlTimestamp(appointment.start_at),
                Number(appointment.duration_minutes),
                appointment.reason || '',
                appointment.status,
                Number(appointment.version),
                mysqlTimestamp(appointment.created_at),
                mysqlTimestamp(appointment.updated_at),
            ],
        );
    }

    for (const event of backup.data.appointmentEvents || []) {
        await connection.execute(
            `INSERT INTO appointment_events
             (id, appointment_id, actor_id, event_type, operation_id,
              payload_hash, details, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                event.id,
                event.appointment_id,
                event.actor_id || null,
                event.event_type,
                event.operation_id,
                event.payload_hash,
                event.details || null,
                mysqlTimestamp(event.created_at),
            ],
        );
    }

    for (const note of backup.data.patientNotes || []) {
        await connection.execute(
            `INSERT INTO patient_notes (id, patient_id, author_id, note, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [note.id, note.patient_id, note.author_id, note.note, mysqlTimestamp(note.created_at)],
        );
    }

    for (const activity of backup.data.patientActivity) {
        await connection.execute(
            `INSERT INTO patient_activity
             (id, patient_id, user_id, action, details, operation_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [activity.id, activity.patient_id, activity.user_id || null, activity.action,
                activity.details || null, activity.operation_id || null,
                mysqlTimestamp(activity.created_at)]
        );
    }

    for (const operation of backup.data.syncOperations) {
        await connection.execute(
            `INSERT INTO sync_operations (operation_id, payload_hash, patient_id, operation_type, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [operation.operation_id, operation.payload_hash, operation.patient_id,
                operation.operation_type, mysqlTimestamp(operation.created_at)]
        );
    }

    for (const event of backup.data.securityAuditLog) {
        await connection.execute(
            `INSERT INTO security_audit_log
             (id, actor_id, actor_role, action, target_id, entity_type, entity_id,
              outcome, request_id, operation_id, details, failure_category, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                event.id,
                event.actor_id || null,
                event.actor_role || null,
                event.action,
                event.target_id || null,
                event.entity_type || null,
                event.entity_id || null,
                event.outcome,
                event.request_id || null,
                event.operation_id || null,
                event.details || null,
                event.failure_category || null,
                mysqlTimestamp(event.created_at),
            ]
        );
    }
    for (const entry of backup.data.syncLogs) {
        await connection.execute(
            `INSERT INTO sync_logs
             (id, user_id, action_type, success, conflict_detected, operation_count, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [entry.id, entry.user_id || null, entry.action_type || null,
                entry.success === undefined ? null : Boolean(entry.success),
                entry.conflict_detected === undefined ? null : Boolean(entry.conflict_detected),
                Number(entry.operation_count), mysqlTimestamp(entry.synced_at)]
        );
    }
    return bootstrapAdmin.username;
}

router.use(requireRole('admin'));
router.use(sensitiveCsrf);

router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.render('admin/data-recovery', {
        user: req.session.user,
        csrfToken: csrfToken(req),
        csvMaxBytes: MAX_IMPORT_BYTES,
        error: typeof req.query.error === 'string' ? req.query.error : null,
        success: typeof req.query.success === 'string' ? req.query.success : null,
    });
});

router.get('/csv/template.csv', (req, res) => {
    res.set({
        'Cache-Control': 'no-store',
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="healthsys-patient-import-template.csv"',
        'X-Content-Type-Options': 'nosniff',
    });
    res.send(`\uFEFF${csvRow(['id', ...PATIENT_FIELDS])}\r\n`);
});

router.get('/audit/events', async (req, res) => {
    const pageValue = String(req.query.page || '1');
    const page = /^\d+$/.test(pageValue) ? Number(pageValue) : 1;
    const action = String(req.query.action || '').trim().slice(0, 80);
    const actorId = String(req.query.actor || '').trim();
    const entityId = String(req.query.entity || '').trim();
    const fromDate = String(req.query.from || '');
    const toDate = String(req.query.to || '');
    const outcome = String(req.query.outcome || '');
    if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000000 ||
        (actorId && !isUuid(actorId)) ||
        (entityId && !isUuid(entityId)) ||
        (fromDate && !isDateOnly(fromDate)) ||
        (toDate && !isDateOnly(toDate)) ||
        (outcome && !['success', 'failure', 'partial', 'conflict', 'already_applied'].includes(outcome))
    ) {
        return res.status(400).json({ error: 'Enter valid audit filters.' });
    }

    const conditions = [];
    const params = [];
    if (action) {
        conditions.push('a.action = ?');
        params.push(action);
    }
    if (actorId) {
        conditions.push('a.actor_id = ?');
        params.push(actorId);
    }
    if (entityId) {
        conditions.push('(a.entity_id = ? OR a.target_id = ?)');
        params.push(entityId, entityId);
    }
    if (outcome) {
        conditions.push('a.outcome = ?');
        params.push(outcome);
    }
    if (fromDate) {
        conditions.push('a.created_at >= ?');
        params.push(`${fromDate} 00:00:00`);
    }
    if (toDate) {
        conditions.push('a.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
        params.push(`${toDate} 00:00:00`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    try {
        const [[countRow]] = await pool.execute(
            `SELECT COUNT(*) AS total FROM security_audit_log a ${where}`,
            params,
        );
        const total = Number(countRow.total);
        const pageSize = 50;
        const pages = Math.max(1, Math.ceil(total / pageSize));
        const currentPage = Math.min(page, pages);
        const offset = (currentPage - 1) * pageSize;
        const [events] = await pool.execute(
            `SELECT a.id, a.actor_id, a.actor_role, u.username AS actor_name,
                    a.action, a.target_id, a.entity_type, a.entity_id, a.outcome,
                    a.request_id, a.operation_id, a.details, a.failure_category,
                    a.created_at
             FROM security_audit_log a
             LEFT JOIN users u ON u.id = a.actor_id
             ${where}
             ORDER BY a.created_at DESC, a.id DESC
             LIMIT ${pageSize} OFFSET ${offset}`,
            params,
        );
        res.set('Cache-Control', 'no-store');
        return res.json({
            events,
            pagination: { page: currentPage, pageSize, pages, total },
        });
    } catch (error) {
        console.error('Audit history query failed:', error.code || 'DATABASE_ERROR');
        return res.status(503).json({ error: 'Audit history is temporarily unavailable.' });
    }
});

router.post('/backup', readBackup);

router.post('/csv/preview', CSV_BODY, async (req, res) => {
    let connection;
    try {
        if (!req.is('text/plain') && !req.is('text/csv')) {
            return res.status(415).json({ error: 'Upload a CSV file as plain text.' });
        }
        let parsed;
        try {
            parsed = validatePatientCsv(req.body);
        } catch (validationError) {
            await recordAudit({
                actorId: req.session.user.id,
                action: 'patient.import.csv.preview',
                outcome: 'failure',
            });
            return res.status(400).json({ error: validationError.message });
        }
        connection = await pool.getConnection();
        const preview = await prepareCsvImport(connection, parsed);
        connection.release();
        connection = null;
        await recordAudit({
            actorId: req.session.user.id,
            action: 'patient.import.csv.preview',
            outcome: 'success',
        });
        const { validRows, ...previewSummary } = preview;
        return res.json({
            ...previewSummary,
            validRows: validRows.slice(0, 100).map((row) => ({
                row: row.row,
                id: row.id,
                full_name: row.data.full_name,
                date_of_birth: row.data.date_of_birth,
                gender: row.data.gender,
                phone: row.data.phone,
            })),
            validRowsShown: Math.min(validRows.length, 100),
        });
    } catch (error) {
        if (connection) {
            connection.release();
            connection = null;
        }
        console.error('Patient CSV preview failed:', error.code || 'DATABASE_ERROR');
        await recordAudit({
            actorId: req.session.user.id,
            action: 'patient.import.csv.preview',
            outcome: 'failure',
        });
        return res.status(503).json({ error: 'CSV preview is temporarily unavailable. Please try again.' });
    } finally {
        if (connection) connection.release();
    }
});

router.post('/csv/import', CSV_BODY, async (req, res) => {
    let connection;
    let rowCount = 0;
    let skippedRows = 0;
    let rejectedRows = 0;
    try {
        if (!req.is('text/plain') && !req.is('text/csv')) {
            return res.status(415).json({ error: 'Upload a CSV file as plain text.' });
        }
        if (req.get('X-Import-Confirmed') !== 'yes') {
            return res.status(400).json({ error: 'Confirm the CSV import before continuing.' });
        }
        let parsed;
        try {
            parsed = validatePatientCsv(req.body);
        } catch (validationError) {
            await recordAudit({
                actorId: req.session.user.id,
                action: 'patient.import.csv',
                outcome: 'failure',
            });
            return res.status(400).json({
                error: validationError.message,
                summary: { imported: 0, skipped: 0, rejected: 0, failed: 0 },
            });
        }
        rowCount = parsed.validRows.length + parsed.invalidRows.length;
        skippedRows = parsed.skipped;
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const prepared = await prepareCsvImport(connection, parsed);
        rejectedRows = prepared.invalidRows.length;
        if (prepared.invalidRows.length > 0 || prepared.validRows.length === 0) {
            await connection.rollback();
            connection.release();
            connection = null;
            await recordAudit({
                actorId: req.session.user.id,
                action: 'patient.import.csv',
                outcome: 'failure',
            });
            return res.status(422).json({
                error: prepared.validRows.length
                    ? 'Correct or remove invalid rows before importing; no records were changed.'
                    : 'No valid rows are available to import.',
                summary: {
                    imported: 0,
                    skipped: prepared.skipped + prepared.validRows.length,
                    rejected: prepared.invalidRows.length,
                    failed: 0,
                },
                invalidRows: prepared.invalidRows,
            });
        }
        for (const row of prepared.validRows) {
            await connection.execute(
                `INSERT INTO patients
                 (id, full_name, date_of_birth, gender, phone, address,
                  emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
                  allergies, medical_history, medications)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [row.id, ...PATIENT_FIELDS.map((field) => row.data[field])]
            );
            await connection.execute(
                `INSERT INTO patient_activity
                 (patient_id, user_id, action, details)
                 VALUES (?, ?, ?, ?)`,
                [
                    row.id,
                    req.session.user.id,
                    'imported',
                    JSON.stringify({
                        actorRole: req.session.user.role,
                        fields: PATIENT_FIELDS,
                        source: 'csv_import',
                    }),
                ],
            );
        }
        await writeAuditEvent(connection, {
            actorId: req.session.user.id,
            actorRole: req.session.user.role,
            action: 'patient.import.csv',
            entityType: 'patient_import',
            outcome: 'success',
            requestId: req.requestId || null,
            details: {
                imported: prepared.validRows.length,
                skipped: prepared.skipped,
                rejected: 0,
            },
        });
        await connection.commit();
        connection.release();
        connection = null;
        return res.json({
            success: true,
            summary: {
                imported: prepared.validRows.length,
                skipped: prepared.skipped,
                rejected: 0,
                failed: 0,
            },
        });
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Could not roll back CSV import:', rollbackError.code || 'DATABASE_ERROR');
            }
            connection.release();
            connection = null;
        }
        if (error.code === 'ER_DUP_ENTRY') {
            await recordAudit({
                actorId: req.session.user.id,
                action: 'patient.import.csv',
                outcome: 'failure',
            });
            return res.status(409).json({
                error: 'A patient ID was added by another request. No CSV rows were imported.',
                summary: { imported: 0, skipped: skippedRows, rejected: rejectedRows, failed: rowCount - rejectedRows },
            });
        }
        console.error('Patient CSV import failed:', error.code || 'IMPORT_ERROR');
        await recordAudit({
            actorId: req.session.user.id,
            action: 'patient.import.csv',
            outcome: 'failure',
        });
        return res.status(500).json({
            error: 'CSV import failed. No records were committed; review the file and retry.',
            summary: { imported: 0, skipped: skippedRows, rejected: rejectedRows, failed: rowCount - rejectedRows },
        });
    } finally {
        if (connection) connection.release();
    }
});

router.post('/backup/restore/preview', BACKUP_BODY, async (req, res) => {
    if (!req.is('text/plain')) return res.status(415).json({ error: 'Upload a JSON backup as plain text.' });
    const parsed = parseUploadedJson(req);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const validation = validateBackupPayload(parsed.value);
    if (!validation.valid) return res.status(400).json({ error: validation.error });

    let connection;
    try {
        connection = await pool.getConnection();
        const freshTarget = await isFreshRestoreTarget(connection, req.session.user.id);
        const passwordReady = !validatePassword(process.env.RESTORE_ADMIN_PASSWORD);
        return res.json({
            valid: true,
            freshTarget,
            passwordReady,
            createdAt: parsed.value.createdAt,
            counts: validation.counts,
            bootstrapAdmin: parsed.value.data.users.find((user) =>
                user.role === 'admin' && user.is_active && !user.is_deleted
            )?.username,
            warning: 'Restore replaces the temporary bootstrap administrator and adds backup records. It does not restore passwords or browser-side pending changes.',
        });
    } catch (error) {
        console.error('Backup restore preview failed:', error.code || 'DATABASE_ERROR');
        return res.status(500).json({ error: 'The target database could not be checked.' });
    } finally {
        if (connection) connection.release();
    }
});

router.post('/backup/restore', BACKUP_BODY, async (req, res) => {
    if (!req.is('text/plain')) return res.status(415).json({ error: 'Upload a JSON backup as plain text.' });
    if (req.get('X-Restore-Confirmation') !== 'RESTORE') {
        return res.status(400).json({ error: 'Type RESTORE to confirm the fresh-database recovery.' });
    }
    const parsed = parseUploadedJson(req);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const validation = validateBackupPayload(parsed.value);
    if (!validation.valid) return res.status(400).json({ error: validation.error });
    const bootstrapPassword = process.env.RESTORE_ADMIN_PASSWORD;
    const passwordError = validatePassword(bootstrapPassword);
    if (passwordError) {
        return res.status(503).json({
            error: 'Set a strong RESTORE_ADMIN_PASSWORD in the server environment before restoring.',
        });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        if (!await isFreshRestoreTarget(connection, req.session.user.id)) {
            await connection.rollback();
            connection.release();
            connection = null;
            await recordAudit({
                actorId: req.session.user.id,
                action: 'backup.server.restore',
                outcome: 'failure',
            });
            return res.status(409).json({
                error: 'Restore is allowed only when the current administrator is the only staff account and patient, activity, visit, and sync tables are empty. No records were changed.',
            });
        }
        const [[existingAuditCount]] = await connection.execute(
            'SELECT COUNT(*) AS total FROM security_audit_log'
        );
        if (Number(existingAuditCount.total) > 0) {
            await connection.rollback();
            connection.release();
            connection = null;
            await recordAudit({
                actorId: req.session.user.id,
                action: 'backup.server.restore',
                outcome: 'failure',
            });
            return res.status(409).json({
                error: 'Restore requires a fresh security audit table as well as empty patient tables. No records were changed.',
            });
        }
        const bootstrapUsername = await insertBackup(connection, parsed.value, bootstrapPassword);
        await writeAuditEvent(connection, {
            actorId: req.session.user.id,
            actorRole: req.session.user.role,
            action: 'backup.server.restore',
            entityType: 'backup',
            outcome: 'success',
            requestId: req.requestId || null,
            details: { restoredDatasetCounts: validation.counts },
        });
        await connection.commit();
        connection.release();
        connection = null;
        return res.json({
            success: true,
            counts: validation.counts,
            bootstrapUsername,
            message: 'Restore completed. Sign in with the restored administrator account and RESTORE_ADMIN_PASSWORD.',
        });
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Could not roll back backup restore:', rollbackError.code || 'DATABASE_ERROR');
            }
            connection.release();
            connection = null;
        }
        await recordAudit({
            actorId: req.session.user.id,
            action: 'backup.server.restore',
            outcome: 'failure',
        });
        console.error('Backup restore failed:', error.code || 'RESTORE_ERROR');
        return res.status(500).json({
            error: 'Restore failed and the transaction was rolled back. Verify migrations and backup compatibility.',
        });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;
