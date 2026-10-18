const assert = require('node:assert/strict');
const test = require('node:test');
const {
    BACKUP_DATASETS,
    BACKUP_FORMAT,
    BACKUP_VERSION,
    validateBackupPayload,
} = require('../backup_format');
const { CSV_HEADERS, csvRow, parseCsv, patientCsvValues, validatePatientCsv } = require('../patient_csv');

const adminId = '7edabf1c-0df9-4f4d-98f0-8c66ad66ca31';
const patientId = '1221b6a0-9014-47c7-8b10-e66311acd821';
const now = '2025-01-01T12:00:00.000Z';

function validBackup(overrides = {}) {
    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        schemaVersion: 1,
        createdAt: now,
        data: {
            patients: [],
            patientVisits: [],
            patientActivity: [],
            patientNotes: [],
            users: [{
                id: adminId,
                username: 'synthetic-admin',
                username_normalized: 'synthetic-admin',
                role: 'admin',
                is_active: 1,
                is_deleted: 0,
                created_by: null,
                created_at: now,
                last_login: null,
                session_version: 1,
            }],
            securityAuditLog: [{
                id: 1,
                actor_id: adminId,
                action: 'staff.login',
                target_id: adminId,
                outcome: 'success',
                request_id: null,
                created_at: now,
            }],
            syncOperations: [],
            syncLogs: [{
                id: 1,
                user_id: adminId,
                action_type: 'patient.sync',
                success: 1,
                conflict_detected: 0,
                operation_count: 2,
                synced_at: now,
            }],
            ...overrides,
        },
    };
}

function validPatient(overrides = {}) {
    return {
        id: patientId,
        full_name: 'Synthetic Patient',
        date_of_birth: '1990-02-28',
        gender: 'female',
        phone: '+14155550100',
        address: 'Synthetic address',
        emergency_contact_name: 'Synthetic Contact',
        emergency_contact_phone: '+14155550101',
        emergency_contact_relationship: 'Friend',
        allergies: 'Synthetic allergy',
        medical_history: 'Synthetic history',
        medications: 'Synthetic medication',
        is_deleted: 0,
        version: 1,
        created_at: now,
        updated_at: now,
        last_modified_by: adminId,
        ...overrides,
    };
}

test('CSV quoting preserves commas, quotes, and newlines while neutralizing formulas', () => {
    const row = ['=1+1', 'Synthetic, "quoted"\ntext', '+14155550100', '-2+3', '@SUM(A1:A2)'];
    const encoded = csvRow(row);
    assert.equal(encoded, "\"'=1+1\",\"Synthetic, \"\"quoted\"\"\ntext\",\"'+14155550100\",\"'-2+3\",\"'@SUM(A1:A2)\"");
    const [decoded] = parseCsv(encoded);
    assert.deepEqual(decoded.map((value) => value.replace(/^'\s*/, '')), row);
});

test('patient CSV export can be imported without formula markers corrupting phone numbers', () => {
    const patient = validPatient();
    const exported = `${csvRow(CSV_HEADERS)}\r\n${csvRow(patientCsvValues(patient))}`;
    const result = validatePatientCsv(exported);
    assert.equal(result.invalidRows.length, 0);
    assert.equal(result.validRows.length, 1);
    assert.equal(result.validRows[0].data.phone, patient.phone);
});

test('CSV validation rejects malformed quoting, duplicate identifiers, and invalid patient fields', () => {
    assert.throws(() => parseCsv('"unclosed'), /unclosed quoted field/);

    const header = csvRow(CSV_HEADERS);
    const first = csvRow(patientCsvValues(validPatient()));
    const duplicate = csvRow(patientCsvValues(validPatient({ full_name: 'Synthetic Duplicate' })));
    const invalid = csvRow(patientCsvValues(validPatient({ date_of_birth: '2030-02-30' })));
    const result = validatePatientCsv(`${header}\n${first}\n${duplicate}\n${invalid}`);
    assert.equal(result.validRows.length, 1);
    assert.equal(result.invalidRows.length, 2);
    assert.match(result.invalidRows[0].errors.map((error) => error.message).join(' '), /duplicated/);
    assert.equal(result.invalidRows[0].errors[0].column, 'id');
    assert.match(result.invalidRows[1].errors.map((error) => error.message).join(' '), /date of birth/);
    assert.ok(result.invalidRows[1].errors.some((error) => error.column === 'date_of_birth'));
    assert.equal(result.invalidRows[0].id, patientId);
});

test('CSV import requires unambiguous ISO dates and rejects impossible dates with a column reference', () => {
    const header = csvRow(CSV_HEADERS);
    const ambiguous = csvRow(patientCsvValues(validPatient({ date_of_birth: '03-04-2000' })));
    const impossible = csvRow(patientCsvValues(validPatient({ date_of_birth: '2000-02-30' })));
    const result = validatePatientCsv(`${header}\r\n${ambiguous}\r\n${impossible}`);
    assert.equal(result.validRows.length, 0);
    assert.equal(result.invalidRows.length, 2);
    assert.ok(result.invalidRows.every((row) =>
        row.errors.some((error) => error.column === 'date_of_birth'),
    ));
});

test('backup validator accepts supported synthetic backup datasets and reports dataset counts', () => {
    const backup = validBackup({ patients: [validPatient()] });
    const validation = validateBackupPayload(backup);
    assert.equal(validation.valid, true);
    assert.equal(validation.counts.patients, 1);
    assert.deepEqual(Object.keys(validation.counts), BACKUP_DATASETS);
});

test('backup audit metadata remains backward compatible and preserves restore actor IDs', () => {
    const legacy = validBackup();
    delete legacy.data.securityAuditLog[0].actor_role;
    assert.equal(validateBackupPayload(legacy).valid, true);

    const backup = validBackup({
        securityAuditLog: [{
            ...validBackup().data.securityAuditLog[0],
            actor_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            actor_role: 'admin',
            entity_type: 'backup',
            entity_id: null,
            operation_id: null,
            details: '{"restoredDatasetCounts":{"patients":1}}',
            failure_category: null,
            action: 'backup.server.restore',
        }],
    });

    test('patient notes are backed up with an author and old backups remain supported', () => {
        const legacy = validBackup({ patients: [validPatient()] });
        delete legacy.data.patientNotes;
        assert.equal(validateBackupPayload(legacy).valid, true);
        assert.equal(validateBackupPayload(legacy).counts.patientNotes, 0);

        const backup = validBackup({
            patients: [validPatient()],
            patientNotes: [{
                id: 1,
                patient_id: patientId,
                author_id: adminId,
                note: 'Synthetic append-only note',
                created_at: now,
            }],
        });
        assert.equal(validateBackupPayload(backup).valid, true);
        assert.equal(validateBackupPayload(backup).counts.patientNotes, 1);
        backup.data.patientNotes[0].author_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        assert.match(validateBackupPayload(backup).error, /Patient note row.*missing record/);
    });
    assert.equal(validateBackupPayload(backup).valid, true);
    backup.data.securityAuditLog[0].action = 'staff.login';
    assert.match(validateBackupPayload(backup).error, /Security audit row/);
});

test('backup validator rejects incompatible versions and dangling record relationships', () => {
    const incompatible = validBackup();
    incompatible.version++;
    assert.equal(validateBackupPayload(incompatible).valid, false);

    const danglingVisit = validBackup({
        patientVisits: [{
            id: 1,
            patient_id: patientId,
            visit_date: '2025-01-01',
            reason: null,
            notes: null,
            created_at: now,
        }],
    });
    assert.match(validateBackupPayload(danglingVisit).error, /missing patient/);

    const validPatientAndBadOperation = validBackup({
        patients: [validPatient()],
        syncOperations: [{
            operation_id: adminId,
            payload_hash: '0'.repeat(64),
            patient_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            operation_type: 'EDIT',
            created_at: now,
        }],
    });
    assert.match(validateBackupPayload(validPatientAndBadOperation).error, /missing patient/);
});

test('appointment backups preserve schedule history and remain backward compatible', () => {
    const legacy = validBackup({ patients: [validPatient()] });
    assert.equal(validateBackupPayload(legacy).valid, true);
    assert.equal(validateBackupPayload(legacy).counts.appointments, 0);
    assert.equal(validateBackupPayload(legacy).counts.appointmentEvents, 0);

    const backup = validBackup({
        patients: [validPatient()],
        appointments: [{
            id: '81dbf51d-c350-4faf-91ed-2862ce6ca178',
            patient_id: patientId,
            assigned_staff_id: adminId,
            created_by: adminId,
            start_at: '2030-02-28 14:30:00',
            duration_minutes: 30,
            reason: 'Synthetic follow-up',
            status: 'cancelled',
            version: 2,
            created_at: now,
            updated_at: now,
        }],
        appointmentEvents: [{
            id: 1,
            appointment_id: '81dbf51d-c350-4faf-91ed-2862ce6ca178',
            actor_id: adminId,
            event_type: 'cancelled',
            operation_id: '63cbfb08-d5b1-47a5-a7eb-e3bd15d37adb',
            payload_hash: 'a'.repeat(64),
            details: '{"to":"cancelled"}',
            created_at: now,
        }],
    });
    const validation = validateBackupPayload(backup);
    assert.equal(validation.valid, true);
    assert.equal(validation.counts.appointments, 1);
    assert.equal(validation.counts.appointmentEvents, 1);

    backup.data.appointments[0].assigned_staff_id =
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    assert.match(validateBackupPayload(backup).error, /Appointment row.*missing record/);
});
