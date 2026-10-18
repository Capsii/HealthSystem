const { isDateOnly, isUuid, normalizePatientData } = require('./patient_validation');
const { isAllowedDuration } = require('./appointment_validation');

const BACKUP_FORMAT = 'healthsys-server-backup';
const BACKUP_VERSION = 1;
const BACKUP_DATASETS = [
    'patients',
    'patientVisits',
    'patientVisitVitals',
    'patientVisitEvents',
    'patientActivity',
    'patientNotes',
    'appointments',
    'appointmentEvents',
    'users',
    'securityAuditLog',
    'syncOperations',
    'syncLogs',
];
const MAX_RESTORE_ROWS = 100000;

function validTimestamp(value, nullable = false) {
    if (nullable && value === null) return true;
    return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function validateBackupPayload(backup) {
    const fail = (error) => ({ valid: false, error });
    if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
        return fail('Backup root must be a JSON object.');
    }
    if (backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION) {
        return fail('Backup format or version is not supported.');
    }
    if (!validTimestamp(backup.createdAt) || backup.schemaVersion !== 1) {
        return fail('Backup timestamp or schema version is invalid.');
    }
    if (!backup.data || typeof backup.data !== 'object' || Array.isArray(backup.data)) {
        return fail('Backup data section is missing.');
    }
    const optionalDatasets = new Set([
        'patientNotes',
        'appointments',
        'appointmentEvents',
        'patientVisitVitals',
        'patientVisitEvents',
    ]);
    for (const dataset of BACKUP_DATASETS.filter((name) => !optionalDatasets.has(name))) {
        if (!Array.isArray(backup.data[dataset])) return fail(`Backup is missing the ${dataset} dataset.`);
    }
    for (const dataset of optionalDatasets) {
        if (backup.data[dataset] !== undefined && !Array.isArray(backup.data[dataset])) {
            return fail(`Backup ${dataset} dataset must be an array.`);
        }
    }
    const patientNotes = backup.data.patientNotes || [];
    const appointments = backup.data.appointments || [];
    const appointmentEvents = backup.data.appointmentEvents || [];
    const patientVisitVitals = backup.data.patientVisitVitals || [];
    const patientVisitEvents = backup.data.patientVisitEvents || [];
    const totalRows = BACKUP_DATASETS.reduce(
        (sum, dataset) => sum + (
            dataset === 'patientNotes'
                ? patientNotes.length
                : dataset === 'appointments'
                    ? appointments.length
                    : dataset === 'appointmentEvents'
                        ? appointmentEvents.length
                        : dataset === 'patientVisitVitals'
                            ? patientVisitVitals.length
                            : dataset === 'patientVisitEvents'
                                ? patientVisitEvents.length
                        : backup.data[dataset].length
        ),
        0,
    );
    if (totalRows > MAX_RESTORE_ROWS) return fail(`Backup exceeds the ${MAX_RESTORE_ROWS} row limit.`);

    const patientIds = new Set();
    for (const [index, patient] of backup.data.patients.entries()) {
        if (!patient || typeof patient !== 'object' || !isUuid(patient.id) || patientIds.has(patient.id.toLowerCase())) {
            return fail(`Patient row ${index + 1} has a missing, malformed, or duplicate ID.`);
        }
        patientIds.add(patient.id.toLowerCase());
        const validation = normalizePatientData(patient);
        if (validation.error) return fail(`Patient row ${index + 1} is invalid: ${validation.error}`);
        if (![true, false, 0, 1].includes(patient.is_deleted) ||
            !Number.isSafeInteger(Number(patient.version)) || Number(patient.version) < 1 ||
            !validTimestamp(patient.created_at) || !validTimestamp(patient.updated_at, true)) {
            return fail(`Patient row ${index + 1} has invalid status, version, or timestamps.`);
        }
    }

    const userIds = new Set();
    const usernames = new Set();
    for (const [index, user] of backup.data.users.entries()) {
        if (!user || typeof user !== 'object' || !isUuid(user.id) || userIds.has(user.id.toLowerCase())) {
            return fail(`Staff row ${index + 1} has a missing, malformed, or duplicate ID.`);
        }
        const normalized = typeof user.username_normalized === 'string'
            ? user.username_normalized
            : '';
        if (!normalized || normalized !== normalized.trim().toLowerCase() ||
            normalized.length > 50 || usernames.has(normalized)) {
            return fail(`Staff row ${index + 1} has an invalid or duplicate username.`);
        }
        if (typeof user.username !== 'string' || !user.username.trim() || user.username.length > 50 ||
            !['admin', 'staff'].includes(user.role) ||
            ![true, false, 0, 1].includes(user.is_active) ||
            ![true, false, 0, 1].includes(user.is_deleted) ||
            !Number.isSafeInteger(Number(user.session_version)) || Number(user.session_version) < 0 ||
            !validTimestamp(user.created_at) || !validTimestamp(user.last_login, true) ||
            (user.created_by !== null && user.created_by !== undefined && !isUuid(user.created_by))) {
            return fail(`Staff row ${index + 1} has invalid account fields.`);
        }
        userIds.add(user.id.toLowerCase());
        usernames.add(normalized);
    }
    if (!backup.data.users.some((user) => user.role === 'admin' && user.is_active && !user.is_deleted)) {
        return fail('Backup must contain at least one active administrator.');
    }
    for (const user of backup.data.users) {
        if (user.created_by !== null && user.created_by !== undefined &&
            !userIds.has(user.created_by.toLowerCase())) {
            return fail('A staff record references a missing creator account.');
        }
    }
    for (const patient of backup.data.patients) {
        if (patient.last_modified_by !== null && patient.last_modified_by !== undefined &&
            (!isUuid(patient.last_modified_by) || !userIds.has(patient.last_modified_by.toLowerCase()))) {
            return fail('A patient record references a missing editor account.');
        }
    }

    const visitIds = new Map();
    for (const [index, visit] of backup.data.patientVisits.entries()) {
        if (!visit || !Number.isSafeInteger(Number(visit.id)) || Number(visit.id) < 1 ||
            visitIds.has(Number(visit.id)) || !isUuid(visit.patient_id) ||
            !patientIds.has(visit.patient_id.toLowerCase()) ||
            !isDateOnly(String(visit.visit_date || '').slice(0, 10)) ||
            !validTimestamp(visit.created_at) ||
            ![visit.reason, visit.notes, visit.visit_type, visit.assessment, visit.diagnosis,
                visit.treatment_plan].every((value) => value === undefined || value === null || typeof value === 'string') ||
            (visit.status !== undefined && !['in_progress', 'completed'].includes(visit.status)) ||
            (visit.version !== undefined && (!Number.isSafeInteger(Number(visit.version)) || Number(visit.version) < 1)) ||
            (visit.created_by !== undefined && visit.created_by !== null &&
                (!isUuid(visit.created_by) || !userIds.has(visit.created_by.toLowerCase()))) ||
            (visit.updated_by !== undefined && visit.updated_by !== null &&
                (!isUuid(visit.updated_by) || !userIds.has(visit.updated_by.toLowerCase()))) ||
            (visit.attending_staff_id !== undefined && visit.attending_staff_id !== null &&
                (!isUuid(visit.attending_staff_id) || !userIds.has(visit.attending_staff_id.toLowerCase()))) ||
            (visit.updated_at !== undefined && !validTimestamp(visit.updated_at, true))) {
            return fail(`Visit row ${index + 1} is invalid or references a missing patient.`);
        }
        visitIds.set(Number(visit.id), visit.patient_id.toLowerCase());
    }

    const vitalIds = new Set();
    for (const [index, vital] of patientVisitVitals.entries()) {
        const values = [
            ['systolic_mmhg', 40, 300],
            ['diastolic_mmhg', 20, 200],
            ['pulse_bpm', 20, 300],
            ['temperature_celsius', 25, 45],
            ['respiratory_rate_per_minute', 4, 80],
            ['oxygen_saturation_percent', 40, 100],
            ['height_cm', 20, 250],
            ['weight_kg', 0.2, 500],
        ];
        if (!vital || !Number.isSafeInteger(Number(vital.id)) || Number(vital.id) < 1 ||
            vitalIds.has(Number(vital.id)) || !visitIds.has(Number(vital.visit_id)) ||
            !isUuid(vital.recorded_by) || !userIds.has(vital.recorded_by.toLowerCase()) ||
            !validTimestamp(vital.recorded_at) ||
            values.some(([field, minimum, maximum]) =>
                vital[field] !== null && vital[field] !== undefined &&
                (!Number.isFinite(Number(vital[field])) ||
                    Number(vital[field]) < minimum || Number(vital[field]) > maximum))) {
            return fail(`Vital-sign row ${index + 1} is invalid or references a missing visit or author.`);
        }
        vitalIds.add(Number(vital.id));
        if ((vital.systolic_mmhg === null) !== (vital.diastolic_mmhg === null)) {
            return fail(`Vital-sign row ${index + 1} has incomplete blood pressure.`);
        }
    }

    const visitEventIds = new Set();
    for (const [index, event] of patientVisitEvents.entries()) {
        if (!event || !Number.isSafeInteger(Number(event.id)) || Number(event.id) < 1 ||
            visitEventIds.has(Number(event.id)) || !visitIds.has(Number(event.visit_id)) ||
            !isUuid(event.patient_id) ||
            visitIds.get(Number(event.visit_id)) !== event.patient_id.toLowerCase() ||
            (event.actor_id !== null && event.actor_id !== undefined &&
                (!isUuid(event.actor_id) || !userIds.has(event.actor_id.toLowerCase()))) ||
            !['created', 'updated'].includes(event.event_type) ||
            typeof event.details !== 'string' || event.details.length > 60000 ||
            !validTimestamp(event.created_at)) {
            return fail(`Visit history row ${index + 1} is invalid or references a missing visit.`);
        }
        visitEventIds.add(Number(event.id));
    }

    const appointmentIds = new Set();
    for (const [index, appointment] of appointments.entries()) {
        if (
            !appointment ||
            !isUuid(appointment.id) ||
            appointmentIds.has(appointment.id.toLowerCase()) ||
            !isUuid(appointment.patient_id) ||
            !patientIds.has(appointment.patient_id.toLowerCase()) ||
            !isUuid(appointment.assigned_staff_id) ||
            !userIds.has(appointment.assigned_staff_id.toLowerCase()) ||
            !isUuid(appointment.created_by) ||
            !userIds.has(appointment.created_by.toLowerCase()) ||
            !validTimestamp(appointment.start_at) ||
            !isAllowedDuration(appointment.duration_minutes) ||
            !['scheduled', 'completed', 'cancelled', 'missed'].includes(appointment.status) ||
            !Number.isSafeInteger(Number(appointment.version)) ||
            Number(appointment.version) < 1 ||
            (appointment.reason !== null && typeof appointment.reason !== 'string') ||
            (appointment.reason || '').length > 500 ||
            !validTimestamp(appointment.created_at) ||
            !validTimestamp(appointment.updated_at)
        ) {
            return fail(`Appointment row ${index + 1} is invalid or references a missing record.`);
        }
        appointmentIds.add(appointment.id.toLowerCase());
    }

    const appointmentEventIds = new Set();
    const appointmentOperationIds = new Set();
    for (const [index, event] of appointmentEvents.entries()) {
        if (
            !event ||
            !Number.isSafeInteger(Number(event.id)) ||
            Number(event.id) < 1 ||
            appointmentEventIds.has(Number(event.id)) ||
            !isUuid(event.appointment_id) ||
            !appointmentIds.has(event.appointment_id.toLowerCase()) ||
            (event.actor_id !== null && event.actor_id !== undefined &&
                (!isUuid(event.actor_id) || !userIds.has(event.actor_id.toLowerCase()))) ||
            !['scheduled', 'rescheduled', 'cancelled', 'completed', 'missed'].includes(event.event_type) ||
            !isUuid(event.operation_id) ||
            appointmentOperationIds.has(event.operation_id.toLowerCase()) ||
            !/^[0-9a-f]{64}$/i.test(event.payload_hash || '') ||
            (event.details !== null && event.details !== undefined && typeof event.details !== 'string') ||
            !validTimestamp(event.created_at)
        ) {
            return fail(`Appointment history row ${index + 1} is invalid or references a missing record.`);
        }
        appointmentEventIds.add(Number(event.id));
        appointmentOperationIds.add(event.operation_id.toLowerCase());
    }

    const activityIds = new Set();
    const activityOperationIds = new Set();
    for (const [index, activity] of backup.data.patientActivity.entries()) {
        if (!activity || !Number.isSafeInteger(Number(activity.id)) || Number(activity.id) < 1 ||
            activityIds.has(Number(activity.id)) ||
            !isUuid(activity.patient_id) || !patientIds.has(activity.patient_id.toLowerCase()) ||
            typeof activity.action !== 'string' || !activity.action.trim() || activity.action.length > 50 ||
            (activity.user_id !== null && activity.user_id !== undefined &&
                (!isUuid(activity.user_id) || !userIds.has(activity.user_id.toLowerCase()))) ||
            (activity.operation_id !== null && activity.operation_id !== undefined &&
                (!isUuid(activity.operation_id) || activityOperationIds.has(activity.operation_id.toLowerCase()))) ||
            (activity.details !== null && activity.details !== undefined && typeof activity.details !== 'string') ||
            !validTimestamp(activity.created_at)) {
            return fail(`Activity row ${index + 1} is invalid or references a missing record.`);
        }
        activityIds.add(Number(activity.id));
        if (activity.operation_id) activityOperationIds.add(activity.operation_id.toLowerCase());
    }

    const noteIds = new Set();
    for (const [index, note] of patientNotes.entries()) {
        if (!note || !Number.isSafeInteger(Number(note.id)) || Number(note.id) < 1 ||
            noteIds.has(Number(note.id)) || !isUuid(note.patient_id) ||
            !patientIds.has(note.patient_id.toLowerCase()) || !isUuid(note.author_id) ||
            !userIds.has(note.author_id.toLowerCase()) || typeof note.note !== 'string' ||
            !note.note.trim() || note.note.length > 10000 || !validTimestamp(note.created_at)) {
            return fail(`Patient note row ${index + 1} is invalid or references a missing record.`);
        }
        noteIds.add(Number(note.id));
    }

    const operationIds = new Set();
    for (const [index, operation] of backup.data.syncOperations.entries()) {
        if (!operation || !isUuid(operation.operation_id) ||
            operationIds.has(operation.operation_id.toLowerCase()) ||
            !/^[0-9a-f]{64}$/i.test(operation.payload_hash || '') ||
            !isUuid(operation.patient_id) || !patientIds.has(operation.patient_id.toLowerCase()) ||
            !['ADD', 'EDIT', 'DELETE'].includes(operation.operation_type) ||
            !validTimestamp(operation.created_at)) {
            return fail(`Synchronization record ${index + 1} is invalid or references a missing patient.`);
        }
        operationIds.add(operation.operation_id.toLowerCase());
    }

    const auditIds = new Set();
    const auditOperationIds = new Set();
    for (const [index, event] of backup.data.securityAuditLog.entries()) {
        if (!event || !Number.isSafeInteger(Number(event.id)) || Number(event.id) < 1 ||
            auditIds.has(Number(event.id)) ||
            typeof event.action !== 'string' || !event.action.trim() || event.action.length > 80 ||
            typeof event.outcome !== 'string' || !event.outcome.trim() || event.outcome.length > 20 ||
            (event.actor_id !== null && event.actor_id !== undefined && !isUuid(event.actor_id)) ||
            (event.target_id !== null && event.target_id !== undefined && !isUuid(event.target_id)) ||
            (event.entity_id !== null && event.entity_id !== undefined && !isUuid(event.entity_id)) ||
            (event.request_id !== null && event.request_id !== undefined && !isUuid(event.request_id)) ||
            (event.operation_id !== null && event.operation_id !== undefined &&
                (!isUuid(event.operation_id) || auditOperationIds.has(event.operation_id.toLowerCase()))) ||
            (event.actor_role !== null && event.actor_role !== undefined &&
                !['admin', 'staff'].includes(event.actor_role)) ||
            (event.entity_type !== null && event.entity_type !== undefined &&
                (typeof event.entity_type !== 'string' || event.entity_type.length > 40)) ||
            (event.details !== null && event.details !== undefined &&
                (typeof event.details !== 'string' || event.details.length > 60000)) ||
            (event.failure_category !== null && event.failure_category !== undefined &&
                (typeof event.failure_category !== 'string' || event.failure_category.length > 60)) ||
            (event.actor_id !== null && event.actor_id !== undefined &&
                !userIds.has(event.actor_id.toLowerCase()) &&
                event.action !== 'backup.server.restore') ||
            !validTimestamp(event.created_at)) {
            return fail(`Security audit row ${index + 1} is invalid.`);
        }
        auditIds.add(Number(event.id));
        if (event.operation_id) auditOperationIds.add(event.operation_id.toLowerCase());
    }

    const syncLogIds = new Set();
    for (const [index, entry] of backup.data.syncLogs.entries()) {
        if (!entry || !Number.isSafeInteger(Number(entry.id)) || Number(entry.id) < 1 ||
            syncLogIds.has(Number(entry.id)) ||
            (entry.user_id !== null && entry.user_id !== undefined &&
                (!isUuid(entry.user_id) || !userIds.has(entry.user_id.toLowerCase()))) ||
            !Number.isSafeInteger(Number(entry.operation_count)) || Number(entry.operation_count) < 0 ||
            (entry.action_type !== null && entry.action_type !== undefined &&
                (typeof entry.action_type !== 'string' || entry.action_type.length > 50)) ||
            (entry.success !== null && entry.success !== undefined && ![true, false, 0, 1].includes(entry.success)) ||
            (entry.conflict_detected !== null && entry.conflict_detected !== undefined &&
                ![true, false, 0, 1].includes(entry.conflict_detected)) ||
            !validTimestamp(entry.synced_at)) {
            return fail(`Synchronization history row ${index + 1} is invalid.`);
        }
        syncLogIds.add(Number(entry.id));
    }

    return {
        valid: true,
        counts: Object.fromEntries(BACKUP_DATASETS.map((dataset) => [
            dataset,
            dataset === 'patientNotes'
                ? patientNotes.length
                : dataset === 'appointments'
                    ? appointments.length
                    : dataset === 'appointmentEvents'
                        ? appointmentEvents.length
                        : dataset === 'patientVisitVitals'
                            ? patientVisitVitals.length
                            : dataset === 'patientVisitEvents'
                                ? patientVisitEvents.length
                        : backup.data[dataset].length,
        ])),
    };
}

module.exports = {
    BACKUP_DATASETS,
    BACKUP_FORMAT,
    BACKUP_VERSION,
    MAX_RESTORE_ROWS,
    validateBackupPayload,
};
