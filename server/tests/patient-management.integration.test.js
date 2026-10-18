const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db');
const migrate = require('../migrate_patient_management');
const migrateStaffSecurity = require('../migrate_staff_security');
const migrateSyncIdempotency = require('../migrate_sync_idempotency');
const migrateSyncLogs = require('../migrate_sync_logs');
const migrateSecurityAudit = require('../migrate_security_audit');
const migratePatientEncounters = require('../migrate_patient_encounters');
const patientRouter = require('../routes/patients');
const syncRouter = require('../routes/sync');
const dashboardRouter = require('../routes/dashboard');
const adminRouter = require('../routes/admin');
const recoveryRouter = require('../routes/recovery');
const { CSV_HEADERS, csvRow } = require('../patient_csv');
const {
  assertIsolatedIntegrationDatabase,
} = require('./integration_test_guard');

test('patient management database integration', async (t) => {
  const actorId = uuidv4();
  const token = `it-${uuidv4()}`;
  const patientIds = [];
  const userIds = [];
  const staffActorId = uuidv4();
  let server;

  try {
    assertIsolatedIntegrationDatabase();
    await migrate();
    await migrateStaffSecurity();
    await migrateSyncIdempotency();
    await migrateSyncLogs();
    await migrateSecurityAudit();
    await migratePatientEncounters();
    userIds.push(actorId, staffActorId);
    await pool.execute(
      `INSERT INTO users
             (id, username, username_normalized, password_hash, role, is_active, is_deleted, session_version)
             VALUES (?, ?, ?, ?, 'admin', TRUE, FALSE, 0), (?, ?, ?, ?, 'staff', TRUE, FALSE, 0)`,
      [
        actorId,
        `${token}-admin`,
        `${token}-admin`,
        'integration-only',
        staffActorId,
        `${token}-staff`,
        `${token}-staff`,
        'integration-only',
      ],
    );

    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '..', 'views'));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => {
      const staffRole = req.headers['x-test-role'] === 'staff';
      req.session = {
        csrfToken: 'patient-test-csrf-token',
        user: {
          id: staffRole ? staffActorId : actorId,
          username: staffRole ? `${token}-staff` : `${token}-admin`,
          role: staffRole ? 'staff' : 'admin',
          authVersion: 0,
        },
      };
      if (req.get('x-test-no-csrf') !== 'true') {
        req.headers['x-csrf-token'] = 'patient-test-csrf-token';
      }
      next();
    });
    app.use('/patients', patientRouter);
    app.use('/sync', syncRouter);
    app.use('/dashboard', dashboardRouter);
    app.use('/admin/recovery', recoveryRouter);
    app.use('/admin', adminRouter);

    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    await t.test('lists patients using safe pagination values', async () => {
      for (let index = 0; index < 11; index++) {
        const id = uuidv4();
        patientIds.push(id);
        await pool.execute(
          `INSERT INTO patients (id, full_name, date_of_birth, gender, phone, address)
                     VALUES (?, ?, ?, ?, ?, ?)`,
          [
            id,
            `Integration Pagination ${token} ${String(index).padStart(2, '0')}`,
            '1990-01-01',
            'other',
            '5550000000',
            'Integration test',
          ],
        );
      }

      const firstPage = await fetch(
        `${baseUrl}/patients?search=${encodeURIComponent(token)}&sort=name&direction=asc&pageSize=10&page=1`,
      );
      assert.equal(firstPage.status, 200);
      const firstHtml = await firstPage.text();
      assert.match(firstHtml, /Page 1 of 2/);
      assert.match(firstHtml, new RegExp(`${token} 00`));
      assert.doesNotMatch(firstHtml, new RegExp(`${token} 10`));

      const secondPage = await fetch(
        `${baseUrl}/patients?search=${encodeURIComponent(token)}&sort=name&direction=asc&pageSize=10&page=2`,
      );
      assert.equal(secondPage.status, 200);
      const secondHtml = await secondPage.text();
      assert.match(secondHtml, /Page 2 of 2/);
      assert.match(secondHtml, new RegExp(`${token} 10`));
      assert.doesNotMatch(secondHtml, new RegExp(`${token} 00`));

      const invalidPage = await fetch(
        `${baseUrl}/patients?search=${encodeURIComponent(token)}&pageSize=10&page=1e2`,
      );
      assert.equal(invalidPage.status, 200);
      assert.match(await invalidPage.text(), /Page 1 of 2/);
    });

    await t.test(
      'exports all filtered pages and rejects Staff requests for deleted records',
      async () => {
        const filteredExport = await fetch(
          `${baseUrl}/patients/export.csv?scope=filtered&search=${encodeURIComponent(token)}&gender=other&status=active&fromDate=1990-01-01&toDate=1990-01-01&page=1&pageSize=10`,
          { headers: { Accept: 'text/csv' } },
        );
        assert.equal(filteredExport.status, 200);
        assert.equal(filteredExport.headers.get('X-Exported-Records'), '11');
        const csv = await filteredExport.text();
        assert.equal(csv.split(/\r?\n/).filter(Boolean).length, 12);
        assert.match(csv, new RegExp(`${token} 10`));

        const staffDeletedExport = await fetch(
          `${baseUrl}/patients/export.csv?includeDeleted=true`,
          { headers: { Accept: 'text/csv', 'x-test-role': 'staff' } },
        );
        assert.equal(staffDeletedExport.status, 403);
      },
    );

    let clinicalPatientId;
    await t.test('adds patient clinical fields to the database', async () => {
      const payload = {
        id: uuidv4(),
        operationId: uuidv4(),
        full_name: `<img src=x onerror=alert(1)> Integration Clinical ${token}`,
        date_of_birth: '1988-06-15',
        gender: 'female',
        phone: '5551112222',
        address: 'Integration test address',
        emergency_contact_name: 'Casey Contact',
        emergency_contact_phone: '5553334444',
        emergency_contact_relationship: 'Sibling',
        allergies: 'Penicillin',
        medical_history: 'Asthma',
        medications: 'Inhaler',
      };
      const response = await fetch(`${baseUrl}/patients/add`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.success, true);
      clinicalPatientId = result.id;
      patientIds.push(clinicalPatientId);

      const retryResponse = await fetch(`${baseUrl}/patients/add`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      assert.equal(retryResponse.status, 200);
      assert.equal((await retryResponse.json()).id, clinicalPatientId);
      const duplicateIdResponse = await fetch(`${baseUrl}/patients/add`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          ...payload,
          operationId: uuidv4(),
          full_name: 'Different patient',
        }),
      });
      assert.equal(duplicateIdResponse.status, 409);

      const possibleDuplicate = {
        ...payload,
        id: uuidv4(),
        operationId: uuidv4(),
        full_name: 'Synthetic different name',
      };
      patientIds.push(possibleDuplicate.id);
      const duplicateWarningResponse = await fetch(`${baseUrl}/patients/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(possibleDuplicate),
      });
      assert.equal(duplicateWarningResponse.status, 409);
      const duplicateWarning = await duplicateWarningResponse.json();
      assert.equal(duplicateWarning.code, 'POTENTIAL_DUPLICATE');
      assert.equal(duplicateWarning.matches[0].id, clinicalPatientId);
      const confirmedDuplicateResponse = await fetch(`${baseUrl}/patients/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          ...possibleDuplicate,
          allowPotentialDuplicates: true,
          duplicateAcknowledgedIds: [clinicalPatientId],
        }),
      });
      assert.equal(confirmedDuplicateResponse.status, 200);
      assert.equal((await confirmedDuplicateResponse.json()).id, possibleDuplicate.id);

      const queuedDuplicateId = uuidv4();
      const queuedDuplicateOperationId = uuidv4();
      patientIds.push(queuedDuplicateId);
      const queuedDuplicate = {
        id: queuedDuplicateId,
        full_name: 'Synthetic queued duplicate',
        date_of_birth: payload.date_of_birth,
        gender: payload.gender,
        phone: payload.phone,
        address: 'Synthetic queued address',
      };
      const syncWarningResponse = await fetch(`${baseUrl}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify([{
          operationId: queuedDuplicateOperationId,
          type: 'ADD',
          table: 'patients',
          data: queuedDuplicate,
          timestamp: new Date().toISOString(),
        }]),
      });
      assert.equal(syncWarningResponse.status, 200);
      const syncWarning = await syncWarningResponse.json();
      assert.equal(syncWarning.results[0].status, 'failed');
      assert.equal(syncWarning.results[0].code, 'POTENTIAL_DUPLICATE');
      assert.ok(syncWarning.results[0].matches.some(
        (match) => match.id === clinicalPatientId,
      ));
      const [[notCreated]] = await pool.execute(
        'SELECT id FROM patients WHERE id = ?',
        [queuedDuplicateId],
      );
      assert.equal(notCreated, undefined);

      const syncConfirmedResponse = await fetch(`${baseUrl}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify([{
          operationId: queuedDuplicateOperationId,
          type: 'ADD',
          table: 'patients',
          data: {
            ...queuedDuplicate,
            allowPotentialDuplicates: true,
            duplicateAcknowledgedIds: syncWarning.results[0].matches.map(
              (match) => match.id,
            ),
          },
          timestamp: new Date().toISOString(),
        }]),
      });
      assert.equal(syncConfirmedResponse.status, 200);
      assert.equal((await syncConfirmedResponse.json()).results[0].status, 'applied');

      const [rows] = await pool.execute(
        `SELECT emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
                        allergies, medical_history, medications
                 FROM patients WHERE id = ?`,
        [clinicalPatientId],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].emergency_contact_name, 'Casey Contact');
      assert.equal(rows[0].emergency_contact_phone, '5553334444');
      assert.equal(rows[0].emergency_contact_relationship, 'Sibling');
      assert.equal(rows[0].allergies, 'Penicillin');
      assert.equal(rows[0].medical_history, 'Asthma');
      assert.equal(rows[0].medications, 'Inhaler');
      const [[auditEvent]] = await pool.execute(
        `SELECT actor_role, entity_type, entity_id, operation_id, details
         FROM security_audit_log WHERE operation_id = ?`,
        [payload.operationId],
      );
      assert.equal(auditEvent.actor_role, 'admin');
      assert.equal(auditEvent.entity_type, 'patient');
      assert.equal(auditEvent.entity_id, clinicalPatientId);
      assert.equal(auditEvent.operation_id, payload.operationId);
      assert.ok(JSON.parse(auditEvent.details).fields.includes('allergies'));
      assert.doesNotMatch(auditEvent.details, /Penicillin|Asthma|Inhaler/);
      const [[activityEvent]] = await pool.execute(
        'SELECT operation_id, details FROM patient_activity WHERE patient_id = ? AND action = ?',
        [clinicalPatientId, 'created'],
      );
      assert.equal(activityEvent.operation_id, payload.operationId);
      assert.equal(JSON.parse(activityEvent.details).actorRole, 'admin');
    });

    await t.test(
      'previews and imports CSV transactionally, rejects duplicates, and denies Staff',
      async () => {
        const importedId = uuidv4();
        const invalidId = uuidv4();
        patientIds.push(importedId, invalidId);
        const row = (id, overrides = {}) =>
          csvRow(
            [
              id,
              `Synthetic CSV Patient ${token}`,
              '1992-04-12',
              'female',
              '+14155550123',
              '=synthetic formula test',
              'Casey Contact',
              '+14155550124',
              'Sibling',
              'Synthetic allergy',
              'Synthetic history',
              'Synthetic medication',
              '',
              '',
              '',
              '',
            ].map((value, index) => overrides[index] ?? value),
          );
        const headers = csvRow(CSV_HEADERS);
        const validCsv = `${headers}\r\n${row(importedId)}`;
        const previewResponse = await fetch(
          `${baseUrl}/admin/recovery/csv/preview`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv', Accept: 'application/json' },
            body: validCsv,
          },
        );
        assert.equal(previewResponse.status, 200);
        const preview = await previewResponse.json();
        assert.equal(preview.counts.valid, 1);
        assert.equal(preview.validRows[0].id, importedId);

        const csvMatchPatientId = uuidv4();
        patientIds.push(csvMatchPatientId);
        const uniquePhone = `555${String(Date.now()).slice(-7)}`;
        await pool.execute(
          `INSERT INTO patients (id, full_name, date_of_birth, gender, phone, address)
           VALUES (?, 'Synthetic CSV phone match', '1990-01-01', 'other', ?, 'CSV test fixture')`,
          [csvMatchPatientId, uniquePhone],
        );
        const [[existingPatient]] = await pool.execute(
          'SELECT id, phone FROM patients WHERE id = ?',
          [csvMatchPatientId],
        );
        const phoneMatchResponse = await fetch(
          `${baseUrl}/admin/recovery/csv/preview`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv', Accept: 'application/json' },
            body: `${headers}\r\n${row(uuidv4(), { 4: existingPatient.phone })}`,
          },
        );
        assert.equal(phoneMatchResponse.status, 200);
        const phoneMatch = await phoneMatchResponse.json();
        assert.equal(phoneMatch.counts.potentialMatches, 1);
        assert.deepEqual(phoneMatch.invalidRows[0].matches, [existingPatient.id]);

        const rejectedCsv = `${headers}\r\n${row(importedId)}\r\n${row(invalidId, { 2: '2030-01-01' })}`;
        const rejectedResponse = await fetch(
          `${baseUrl}/admin/recovery/csv/import`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'text/csv',
              Accept: 'application/json',
              'X-Import-Confirmed': 'yes',
            },
            body: rejectedCsv,
          },
        );
        assert.equal(rejectedResponse.status, 422);
        const rejected = await rejectedResponse.json();
        assert.equal(rejected.summary.imported, 0);
        assert.equal(rejected.summary.rejected, 1);
        const [[unchanged]] = await pool.execute(
          'SELECT COUNT(*) AS total FROM patients WHERE id IN (?, ?)',
          [importedId, invalidId],
        );
        assert.equal(Number(unchanged.total), 0);

        const importResponse = await fetch(
          `${baseUrl}/admin/recovery/csv/import`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'text/csv',
              Accept: 'application/json',
              'X-Import-Confirmed': 'yes',
            },
            body: validCsv,
          },
        );
        assert.equal(importResponse.status, 200);
        assert.equal((await importResponse.json()).summary.imported, 1);
        const [[imported]] = await pool.execute(
          'SELECT full_name, phone, address FROM patients WHERE id = ?',
          [importedId],
        );
        assert.equal(imported.full_name, `Synthetic CSV Patient ${token}`);
        assert.equal(imported.phone, '+14155550123');
        assert.equal(imported.address, '=synthetic formula test');

        const auditResponse = await fetch(
          `${baseUrl}/admin/recovery/audit/events?actor=${actorId}&action=patient.import.csv`,
        );
        assert.equal(auditResponse.status, 200);
        const auditResult = await auditResponse.json();
        assert.ok(auditResult.events.some((event) =>
          event.action === 'patient.import.csv' && event.outcome === 'success',
        ));
        const staffAuditResponse = await fetch(
          `${baseUrl}/admin/recovery/audit/events`,
          { headers: { 'x-test-role': 'staff' } },
        );
        assert.equal(staffAuditResponse.status, 403);

        const duplicateResponse = await fetch(
          `${baseUrl}/admin/recovery/csv/import`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'text/csv',
              Accept: 'application/json',
              'X-Import-Confirmed': 'yes',
            },
            body: validCsv,
          },
        );
        assert.equal(duplicateResponse.status, 422);
        const duplicateResult = await duplicateResponse.json();
        assert.equal(duplicateResult.invalidRows[0].id, importedId);

        const staffResponse = await fetch(
          `${baseUrl}/admin/recovery/csv/preview`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'text/csv',
              Accept: 'application/json',
              'x-test-role': 'staff',
            },
            body: validCsv,
          },
        );
        assert.equal(staffResponse.status, 403);
      },
    );

    await t.test(
      'rejects invalid IDs and normalizes phone numbers before database writes',
      async () => {
        const noCsrfResponse = await fetch(`${baseUrl}/patients/add`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'x-test-no-csrf': 'true',
          },
          body: JSON.stringify({ id: uuidv4(), operationId: uuidv4() }),
        });
        assert.equal(noCsrfResponse.status, 403);

        const invalidIdResponse = await fetch(`${baseUrl}/patients/add`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            id: '?',
            operationId: uuidv4(),
            full_name: `Invalid ID ${token}`,
            date_of_birth: '1990-01-01',
            gender: 'other',
            phone: '5554443333',
            address: 'Integration test',
          }),
        });
        assert.equal(invalidIdResponse.status, 400);
        const invalidPhoneResponse = await fetch(`${baseUrl}/patients/add`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            id: uuidv4(),
            operationId: uuidv4(),
            full_name: `Invalid phone ${token}`,
            date_of_birth: '1990-01-01',
            gender: 'other',
            phone: 'not-a-phone',
            address: 'Integration test',
          }),
        });
        assert.equal(invalidPhoneResponse.status, 400);
      },
    );

    await t.test(
      'sync retries with a stable operation ID create one patient and one activity',
      async () => {
        const patientId = uuidv4();
        const operationId = uuidv4();
        patientIds.push(patientId);
        const data = {
          id: patientId,
          version: 1,
          full_name: `Integration Sync ${token}`,
          date_of_birth: '1991-02-03',
          gender: 'other',
          phone: '+91 98765-43210',
          address: 'Sync integration test',
          emergency_contact_name: '',
          emergency_contact_phone: '',
          emergency_contact_relationship: '',
          allergies: '',
          medical_history: '',
          medications: '',
        };
        const operation = {
          operationId,
          type: 'ADD',
          table: 'patients',
          data,
          timestamp: new Date().toISOString(),
        };
        const sendSyncRetry = () =>
          fetch(`${baseUrl}/sync`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify([operation]),
          });
        const response = await sendSyncRetry();
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.deepEqual(result.resolvedIndexes, [0]);
        assert.equal(result.complete, true);
        assert.deepEqual(
          result.results.map((item) => ({
            operationId: item.operationId,
            status: item.status,
          })),
          [{ operationId, status: 'applied' }],
        );
        assert.equal(result.results[0].serverRecord.id, patientId);
        assert.equal(Number(result.results[0].serverRecord.version), 1);
        const retryResponse = await sendSyncRetry();
        assert.equal(retryResponse.status, 200);
        const retriedResult = await retryResponse.json();
        assert.deepEqual(retriedResult.resolvedIndexes, [0]);
        assert.deepEqual(
          retriedResult.results.map((item) => ({
            operationId: item.operationId,
            status: item.status,
          })),
          [{ operationId, status: 'already_applied' }],
        );

        const [[patient]] = await pool.execute(
          'SELECT id, phone, version FROM patients WHERE id = ?',
          [patientId],
        );
        assert.equal(patient.id, patientId);
        assert.equal(patient.phone, '+919876543210');
        assert.equal(Number(patient.version), 1);
        const [[activity]] = await pool.execute(
          'SELECT COUNT(*) AS total FROM patient_activity WHERE patient_id = ?',
          [patientId],
        );
        assert.equal(Number(activity.total), 1);
        const [[ledger]] = await pool.execute(
          'SELECT COUNT(*) AS total FROM sync_operations WHERE operation_id = ?',
          [operationId],
        );
        assert.equal(Number(ledger.total), 1);
      },
    );

    await t.test(
      'a failure during a multi-operation sync rolls back every database change',
      async () => {
        const fixtures = [0, 1].map(() => ({
          patientId: uuidv4(),
          operationId: uuidv4(),
        }));
        patientIds.push(...fixtures.map((fixture) => fixture.patientId));
        const operations = fixtures.map((fixture, index) => ({
          operationId: fixture.operationId,
          type: 'ADD',
          table: 'patients',
          data: {
            id: fixture.patientId,
            version: 1,
            full_name: `Rollback fixture ${index} ${token}`,
            date_of_birth: '1992-03-04',
            gender: 'other',
            phone: `+1555${Number.parseInt(
              fixture.patientId.replaceAll('-', '').slice(0, 7),
              16,
            )
              .toString()
              .padStart(9, '0')}`,
            address: 'Synthetic transaction rollback test',
            emergency_contact_name: '',
            emergency_contact_phone: '',
            emergency_contact_relationship: '',
            allergies: '',
            medical_history: '',
            medications: '',
          },
          timestamp: new Date().toISOString(),
        }));
        const originalGetConnection = pool.getConnection;
        pool.getConnection = async function getConnectionWithInjectedFailure() {
          const connection = await originalGetConnection.call(pool);
          let ledgerInsertCount = 0;
          return {
            async execute(...args) {
              const [sql] = args;
              if (/INSERT INTO sync_operations/i.test(sql)) {
                ledgerInsertCount++;
                if (ledgerInsertCount === 2) {
                  const error = new Error(
                    'Synthetic transaction interruption',
                  );
                  error.code = 'TEST_INJECTED_FAILURE';
                  throw error;
                }
              }
              return connection.execute(...args);
            },
            beginTransaction: (...args) =>
              connection.beginTransaction(...args),
            commit: (...args) => connection.commit(...args),
            rollback: (...args) => connection.rollback(...args),
            release: (...args) => connection.release(...args),
          };
        };

        let response;
        try {
          response = await fetch(`${baseUrl}/sync`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(operations),
          });
        } finally {
          pool.getConnection = originalGetConnection;
        }

        assert.equal(response.status, 500);
        const [patients] = await pool.execute(
          'SELECT id FROM patients WHERE id IN (?, ?)',
          fixtures.map((fixture) => fixture.patientId),
        );
        assert.equal(patients.length, 0);
        const [activities] = await pool.execute(
          `SELECT operation_id FROM patient_activity
           WHERE operation_id IN (?, ?)`,
          fixtures.map((fixture) => fixture.operationId),
        );
        assert.equal(activities.length, 0);
        const [ledgerRows] = await pool.execute(
          `SELECT operation_id FROM sync_operations
           WHERE operation_id IN (?, ?)`,
          fixtures.map((fixture) => fixture.operationId),
        );
        assert.equal(ledgerRows.length, 0);
      },
    );

    await t.test(
      'sync rejects stale versions and leaves malformed operations unresolved',
      async () => {
        const patientId = uuidv4();
        patientIds.push(patientId);
        await pool.execute(
          `INSERT INTO patients (id, full_name, date_of_birth, gender, phone, address)
                 VALUES (?, ?, '1990-01-01', 'other', '5552223333', 'Version test')`,
          [patientId, `Integration Version ${token}`],
        );
        const [[createdBefore]] = await pool.execute(
          'SELECT created_at FROM patients WHERE id = ?',
          [patientId],
        );
        const base = {
          id: patientId,
          version: 1,
          full_name: `Integration Version Updated ${token}`,
          date_of_birth: '1990-01-01',
          gender: 'other',
          phone: '5552223333',
          address: 'Version test',
          emergency_contact_name: '',
          emergency_contact_phone: '',
          emergency_contact_relationship: '',
          allergies: '',
          medical_history: '',
          medications: '',
        };
        const firstEdit = {
          operationId: uuidv4(),
          type: 'EDIT',
          table: 'patients',
          data: base,
          timestamp: new Date().toISOString(),
        };
        const staleEdit = {
          ...firstEdit,
          operationId: uuidv4(),
          data: { ...base, full_name: `Stale edit ${token}` },
        };
        const response = await fetch(`${baseUrl}/sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify([
            firstEdit,
            staleEdit,
            {
              type: 'ADD',
              table: 'patients',
              data: { id: '?' },
            },
          ]),
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.deepEqual(result.resolvedIndexes, [0]);
        assert.equal(result.conflicts, 1);
        assert.equal(result.skipped, 1);
        assert.equal(result.failures[0].index, 2);
        assert.equal(result.results[0].status, 'applied');
        assert.equal(result.results[1].operationId, staleEdit.operationId);
        assert.equal(result.results[1].status, 'conflict');
        assert.equal(Number(result.results[1].serverRecord.version), 2);
        assert.equal(result.results[2].status, 'failed');

        const [[patient]] = await pool.execute(
          'SELECT full_name, version FROM patients WHERE id = ?',
          [patientId],
        );
        assert.equal(patient.full_name, base.full_name);
        assert.equal(Number(patient.version), 2);

        const concurrentOperations = ['Concurrent A', 'Concurrent B'].map(
          (label) => ({
            operationId: uuidv4(),
            type: 'EDIT',
            table: 'patients',
            data: { ...base, version: 2, full_name: `${label} ${token}` },
            timestamp: new Date().toISOString(),
          }),
        );
        const concurrentResponses = await Promise.all(
          concurrentOperations.map((operation) =>
            fetch(`${baseUrl}/sync`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              body: JSON.stringify([operation]),
            }),
          ),
        );
        assert.deepEqual(
          concurrentResponses.map((result) => result.status),
          [200, 200],
        );
        const concurrentResults = await Promise.all(
          concurrentResponses.map((result) => result.json()),
        );
        assert.equal(
          concurrentResults.reduce((sum, result) => sum + result.processed, 0),
          1,
        );
        assert.equal(
          concurrentResults.reduce((sum, result) => sum + result.conflicts, 0),
          1,
        );
        const conflictResult = concurrentResults
          .flatMap((result) => result.results)
          .find((item) => item.status === 'conflict');
        assert.equal(Number(conflictResult.serverRecord.version), 3);
        const [[afterConcurrentEdits]] = await pool.execute(
          'SELECT full_name, version, created_at FROM patients WHERE id = ?',
          [patientId],
        );
        assert.equal(Number(afterConcurrentEdits.version), 3);
        assert.match(afterConcurrentEdits.full_name, /^Concurrent [AB] /);
        assert.equal(afterConcurrentEdits.created_at, createdBefore.created_at);
      },
    );

    await t.test(
      'two-client conflict scenarios (release requirement)',
      async (t) => {
        async function createPatient(label) {
          const id = uuidv4();
          patientIds.push(id);
          await pool.execute(
            `INSERT INTO patients (id, full_name, date_of_birth, gender, phone, address)
                     VALUES (?, ?, '1990-01-01', 'other', '5552223333', ?)`,
            [id, `Two-client ${label} ${token}`, `Initial address ${label}`],
          );
          return {
            id,
            version: 1,
            full_name: `Two-client ${label} ${token}`,
            date_of_birth: '1990-01-01',
            gender: 'other',
            phone: '5552223333',
            address: `Initial address ${label}`,
            emergency_contact_name: '',
            emergency_contact_phone: '',
            emergency_contact_relationship: '',
            allergies: '',
            medical_history: '',
            medications: '',
          };
        }

        function operation(snapshot, type, changes = {}) {
          return {
            operationId: uuidv4(),
            type,
            table: 'patients',
            data: { ...snapshot, ...changes },
            timestamp: new Date().toISOString(),
          };
        }

        async function syncAs(client, item) {
          const response = await fetch(`${baseUrl}/sync`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'x-test-client': client,
            },
            body: JSON.stringify([item]),
          });
          assert.equal(response.status, 200);
          return response.json();
        }

        async function readPatient(id) {
          const [[row]] = await pool.execute(
            'SELECT phone, address, full_name, version, is_deleted FROM patients WHERE id = ?',
            [id],
          );
          return row;
        }

        await t.test(
          'same-field edits reject the stale client and report the retained conflict',
          async () => {
            const snapshot = await createPatient('same-field');
            const clientA = operation(snapshot, 'EDIT', {
              phone: '5551111111',
            });
            const clientB = operation(snapshot, 'EDIT', {
              phone: '5552222222',
            });

            const resultA = await syncAs('client-a', clientA);
            const resultB = await syncAs('client-b', clientB);
            assert.deepEqual(resultA.resolvedIndexes, [0]);
            assert.equal(resultA.conflicts, 0);
            assert.deepEqual(resultB.resolvedIndexes, []);
            assert.equal(resultB.conflicts, 1);
            assert.equal(resultB.conflictDetails[0].reason, 'version_mismatch');
            assert.equal(Number(resultB.conflictDetails[0].serverVersion), 2);

            const row = await readPatient(snapshot.id);
            assert.equal(row.phone, '5551111111');
            assert.equal(Number(row.version), 2);
          },
        );

        await t.test(
          'different-field edits reject a stale full-record snapshot instead of losing data silently',
          async () => {
            const snapshot = await createPatient('different-field');
            const resultA = await syncAs(
              'client-a',
              operation(snapshot, 'EDIT', { address: 'Client A address' }),
            );
            const resultB = await syncAs(
              'client-b',
              operation(snapshot, 'EDIT', { phone: '5553333333' }),
            );
            assert.deepEqual(resultA.resolvedIndexes, [0]);
            assert.equal(resultB.conflicts, 1);
            assert.equal(resultB.conflictDetails[0].reason, 'version_mismatch');

            const row = await readPatient(snapshot.id);
            assert.equal(row.address, 'Client A address');
            assert.equal(row.phone, snapshot.phone);
            assert.equal(Number(row.version), 2);
          },
        );

        await t.test(
          'offline stale edits remain conflicted after another client commits',
          async () => {
            const offlineSnapshot = await createPatient('offline-stale');
            const onlineResult = await syncAs(
              'client-b',
              operation(offlineSnapshot, 'EDIT', {
                full_name: `Online edit ${token}`,
              }),
            );
            const staleResult = await syncAs(
              'client-a',
              operation(offlineSnapshot, 'EDIT', { phone: '5554444444' }),
            );
            assert.deepEqual(onlineResult.resolvedIndexes, [0]);
            assert.equal(staleResult.conflicts, 1);
            assert.equal(
              staleResult.conflictDetails[0].reason,
              'version_mismatch',
            );

            const row = await readPatient(offlineSnapshot.id);
            assert.equal(row.full_name, `Online edit ${token}`);
            assert.equal(row.phone, offlineSnapshot.phone);
            assert.equal(Number(row.version), 2);
          },
        );

        await t.test(
          'edit-versus-delete conflicts in either ordering without resurrecting or silently discarding',
          async () => {
            const editFirstSnapshot = await createPatient('edit-first');
            const editResult = await syncAs(
              'client-b',
              operation(editFirstSnapshot, 'EDIT', {
                address: 'Edited before delete',
              }),
            );
            const staleDelete = await syncAs(
              'client-a',
              operation(editFirstSnapshot, 'DELETE'),
            );
            assert.deepEqual(editResult.resolvedIndexes, [0]);
            assert.equal(staleDelete.conflicts, 1);
            assert.equal(
              staleDelete.conflictDetails[0].reason,
              'version_mismatch',
            );
            const editFirstRow = await readPatient(editFirstSnapshot.id);
            assert.equal(editFirstRow.address, 'Edited before delete');
            assert.equal(Boolean(editFirstRow.is_deleted), false);
            assert.equal(Number(editFirstRow.version), 2);

            const deleteFirstSnapshot = await createPatient('delete-first');
            const deleteResult = await syncAs(
              'client-a',
              operation(deleteFirstSnapshot, 'DELETE'),
            );
            const staleEdit = await syncAs(
              'client-b',
              operation(deleteFirstSnapshot, 'EDIT', { phone: '5555555555' }),
            );
            assert.deepEqual(deleteResult.resolvedIndexes, [0]);
            assert.equal(staleEdit.conflicts, 1);
            assert.equal(
              staleEdit.conflictDetails[0].reason,
              'version_mismatch',
            );
            const deleteFirstRow = await readPatient(deleteFirstSnapshot.id);
            assert.equal(Boolean(deleteFirstRow.is_deleted), true);
            assert.equal(deleteFirstRow.phone, deleteFirstSnapshot.phone);
            assert.equal(Number(deleteFirstRow.version), 2);
          },
        );

        await t.test(
          'independent duplicate deletions are acknowledged without duplicate activity',
          async () => {
            const snapshot = await createPatient('duplicate-delete');
            const deletionA = operation(snapshot, 'DELETE');
            const deletionB = operation(snapshot, 'DELETE');

            const resultA = await syncAs('client-a', deletionA);
            const resultB = await syncAs('client-b', deletionB);
            assert.equal(resultA.results[0].status, 'applied');
            assert.equal(resultB.results[0].status, 'already_applied');
            assert.equal(resultB.conflicts, 0);
            assert.deepEqual(resultB.resolvedIndexes, [0]);
            assert.equal(Boolean(resultB.results[0].serverRecord.is_deleted), true);

            const retryResult = await syncAs('client-b', deletionB);
            assert.equal(retryResult.results[0].status, 'already_applied');
            const row = await readPatient(snapshot.id);
            assert.equal(Boolean(row.is_deleted), true);
            assert.equal(Number(row.version), 2);
            const [[activity]] = await pool.execute(
              `SELECT COUNT(*) AS total FROM patient_activity
                       WHERE patient_id = ? AND action = 'deleted'`,
              [snapshot.id],
            );
            assert.equal(Number(activity.total), 1);
          },
        );

        await t.test(
          'out-of-order stale retries cannot revert a newer committed version',
          async () => {
            const snapshot = await createPatient('out-of-order');
            const newer = operation(snapshot, 'EDIT', { phone: '5556666666' });
            const older = operation(snapshot, 'EDIT', { phone: '5557777777' });
            const newerResult = await syncAs('client-b', newer);
            const firstStaleResult = await syncAs('client-a', older);
            const retriedStaleResult = await syncAs('client-a', older);
            assert.deepEqual(newerResult.resolvedIndexes, [0]);
            assert.equal(firstStaleResult.conflicts, 1);
            assert.equal(retriedStaleResult.conflicts, 1);
            assert.equal(
              retriedStaleResult.conflictDetails[0].reason,
              'version_mismatch',
            );

            const row = await readPatient(snapshot.id);
            assert.equal(row.phone, '5556666666');
            assert.equal(Number(row.version), 2);
          },
        );
      },
    );

    await t.test(
      'renders profile, visits, and activity from the database',
      async () => {
        const visitResponse = await fetch(
          `${baseUrl}/patients/visits/add/${clinicalPatientId}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({
              visit_date: '2024-07-10',
              reason: 'Integration checkup',
              notes: 'Integration visit notes',
            }),
          },
        );
        assert.equal(visitResponse.status, 200);
        assert.equal((await visitResponse.json()).success, true);
        const noteResponse = await fetch(
          `${baseUrl}/patients/notes/add/${clinicalPatientId}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ note: 'Synthetic integration note' }),
          },
        );
        assert.equal(noteResponse.status, 200);
        assert.equal((await noteResponse.json()).success, true);

        const profileReturnTo = encodeURIComponent(
          '/patients?search=Synthetic&gender=female&status=active&page=2',
        );
        const profileResponse = await fetch(
          `${baseUrl}/patients/${clinicalPatientId}?returnTo=${profileReturnTo}`,
        );
        assert.equal(profileResponse.status, 200);
        const profileHtml = await profileResponse.text();
        assert.match(
          profileHtml,
          /href="\/patients\?search=Synthetic&amp;gender=female&amp;status=active&amp;page=2">Back to patients/,
        );
        assert.match(profileHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.doesNotMatch(profileHtml, /<img src=x onerror=alert\(1\)>/);
        assert.match(profileHtml, /Casey Contact/);
        assert.match(profileHtml, /Penicillin/);
        assert.match(profileHtml, /Integration checkup/);
        assert.match(profileHtml, /Integration visit notes/);
        assert.match(profileHtml, /Synthetic integration note/);
        assert.match(profileHtml, new RegExp(`${token}-admin ·`));
        assert.match(profileHtml, /Summary generated/);
        assert.match(profileHtml, /Created/);
        assert.match(profileHtml, /Visit recorded/);
        const unsafeReturnResponse = await fetch(
          `${baseUrl}/patients/${clinicalPatientId}?returnTo=${encodeURIComponent('https://example.invalid/')}`,
        );
        assert.equal(unsafeReturnResponse.status, 200);
        assert.match(await unsafeReturnResponse.text(), /href="\/patients">Back to patients/);

        const [[auditAccess]] = await pool.execute(
          `SELECT COUNT(*) AS total FROM security_audit_log
                 WHERE actor_id = ? AND action = 'patient.access' AND target_id = ?`,
          [actorId, clinicalPatientId],
        );
        assert.ok(Number(auditAccess.total) >= 1);

        const [visitRows] = await pool.execute(
          'SELECT patient_id FROM patient_visits WHERE patient_id = ?',
          [clinicalPatientId],
        );
        assert.equal(visitRows.length, 1);
        const [activityRows] = await pool.execute(
          'SELECT action FROM patient_activity WHERE patient_id = ? ORDER BY created_at, id',
          [clinicalPatientId],
        );
        assert.deepEqual(
          activityRows.map((row) => row.action),
          ['created', 'visit recorded', 'note added'],
        );
      },
    );

    await t.test(
      'dashboard metrics match database definitions and respect admin-only destinations',
      async () => {
        const staffFixtureIds = [uuidv4(), uuidv4(), uuidv4()];
        userIds.push(...staffFixtureIds);
        await pool.execute(
          `INSERT INTO users
                 (id, username, username_normalized, password_hash, role, is_active, is_deleted, session_version)
                 VALUES (?, ?, ?, ?, 'staff', TRUE, FALSE, 0),
                        (?, ?, ?, ?, 'staff', FALSE, FALSE, 0),
                        (?, ?, ?, ?, 'staff', TRUE, TRUE, 0)`,
          [
            staffFixtureIds[0],
            `${token}-active`,
            `${token}-active`,
            'integration-only',
            staffFixtureIds[1],
            `${token}-inactive`,
            `${token}-inactive`,
            'integration-only',
            staffFixtureIds[2],
            `${token}-deleted`,
            `${token}-deleted`,
            'integration-only',
          ],
        );

        const [patientRows] = await pool.execute(`
                SELECT COUNT(*) AS total,
                       COALESCE(SUM(is_deleted = FALSE), 0) AS active,
                       COALESCE(SUM(is_deleted = TRUE), 0) AS deleted
                FROM patients
            `);
        const [staffRows] = await pool.execute(`
                SELECT COUNT(*) AS total,
                       COALESCE(SUM(is_active = 1), 0) AS active,
                       COALESCE(SUM(is_active <> 1 OR is_active IS NULL), 0) AS inactive
                FROM users WHERE is_deleted = FALSE
            `);

        const adminMetricsResponse = await fetch(
          `${baseUrl}/dashboard/metrics`,
        );
        assert.equal(adminMetricsResponse.status, 200);
        const adminMetrics = await adminMetricsResponse.json();
        assert.deepEqual(adminMetrics.patients, {
          total: Number(patientRows[0].total),
          active: Number(patientRows[0].active),
          deleted: Number(patientRows[0].deleted),
        });
        assert.deepEqual(adminMetrics.staff, {
          total: Number(staffRows[0].total),
          active: Number(staffRows[0].active),
          inactive: Number(staffRows[0].inactive),
        });
        const [recentPatientRows] = await pool.execute(`
                SELECT id FROM patients
                WHERE is_deleted = FALSE
                ORDER BY created_at DESC, id DESC
                LIMIT 5
            `);
        assert.deepEqual(
          adminMetrics.recentPatients.map((patient) => patient.id),
          recentPatientRows.map((patient) => patient.id),
        );
        assert.ok(Array.isArray(adminMetrics.recentActivity));

        const staffDashboardResponse = await fetch(
          `${baseUrl}/dashboard/metrics`,
          { headers: { 'x-test-role': 'staff' } },
        );
        assert.equal(staffDashboardResponse.status, 200);
        const staffDashboardMetrics = await staffDashboardResponse.json();
        assert.ok(staffDashboardMetrics.recentActivity.every((event) =>
          event.action.startsWith('patient.') || event.action.startsWith('sync.'),
        ));
        const [[staffReportExpected]] = await pool.execute(`
                SELECT COALESCE(SUM(is_deleted = FALSE AND is_active = TRUE), 0) AS active,
                       COALESCE(SUM(is_deleted = FALSE AND (is_active = FALSE OR is_active IS NULL)), 0) AS disabled,
                       COALESCE(SUM(is_deleted = TRUE), 0) AS deleted
                FROM users
            `);
        const reportResponse = await fetch(
          `${baseUrl}/admin/reports?range=all`,
        );
        assert.equal(reportResponse.status, 200);
        const reportHtml = await reportResponse.text();
        assert.match(
          reportHtml,
          new RegExp(`id="reportActiveStaff">${adminMetrics.staff.active}<`),
        );
        assert.match(
          reportHtml,
          new RegExp(
            `id="reportDisabledStaff">${Number(staffReportExpected.disabled)}<`,
          ),
        );
        assert.match(
          reportHtml,
          new RegExp(
            `id="reportDeletedStaff">${Number(staffReportExpected.deleted)}<`,
          ),
        );

        const staffPageResponse = await fetch(`${baseUrl}/admin/staff`);
        assert.equal(staffPageResponse.status, 200);
        const staffPageHtml = await staffPageResponse.text();
        assert.match(staffPageHtml, new RegExp(`${token}-active`));
        assert.match(staffPageHtml, new RegExp(`${token}-inactive`));
        assert.doesNotMatch(staffPageHtml, new RegExp(`${token}-deleted`));

        await pool.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [
          staffFixtureIds[0],
        ]);
        const refreshedResponse = await fetch(`${baseUrl}/dashboard/metrics`);
        const refreshedMetrics = await refreshedResponse.json();
        assert.equal(
          refreshedMetrics.staff.active,
          adminMetrics.staff.active - 1,
        );
        assert.equal(
          refreshedMetrics.staff.inactive,
          adminMetrics.staff.inactive + 1,
        );

        const adminDashboard = await fetch(`${baseUrl}/dashboard`);
        const adminHtml = await adminDashboard.text();
        assert.match(adminHtml, /href="\/patients\?status=active"/);
        assert.match(adminHtml, /href="\/patients\?status=deleted"/);
        assert.match(adminHtml, /href="\/admin\/staff"/);

        const staffMetricsResponse = await fetch(
          `${baseUrl}/dashboard/metrics`,
          {
            headers: { 'x-test-role': 'staff' },
          },
        );
        const staffMetrics = await staffMetricsResponse.json();
        assert.equal(staffMetrics.staff, null);
        const staffDashboard = await fetch(`${baseUrl}/dashboard`, {
          headers: { 'x-test-role': 'staff' },
        });
        const staffHtml = await staffDashboard.text();
        assert.doesNotMatch(staffHtml, /href="\/admin\/staff"/);
        assert.doesNotMatch(staffHtml, /Deleted Patients/);
      },
    );

    await t.test(
      'reports reconcile with management counts and apply UTC date boundaries',
      async () => {
        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(`${today}T00:00:00Z`);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        const tomorrow = new Date(`${today}T00:00:00Z`);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        const records = [
          { id: uuidv4(), createdAt: `${today} 00:00:00`, deleted: false },
          {
            id: uuidv4(),
            createdAt: `${yesterday.toISOString().slice(0, 10)} 23:59:59`,
            deleted: false,
          },
          {
            id: uuidv4(),
            createdAt: `${tomorrow.toISOString().slice(0, 10)} 00:00:00`,
            deleted: false,
          },
          { id: uuidv4(), createdAt: `${today} 12:00:00`, deleted: true },
        ];
        patientIds.push(...records.map((record) => record.id));
        for (const [index, record] of records.entries()) {
          await pool.execute(
            `INSERT INTO patients
                     (id, full_name, date_of_birth, gender, phone, address, created_at, is_deleted)
                     VALUES (?, ?, '1990-01-01', 'other', ?, 'Report boundary fixture', ?, ?)`,
            [
              record.id,
              `${token}-report-boundary-${index}`,
              '5559990000',
              record.createdAt,
              record.deleted,
            ],
          );
        }

        const [statusRows] = await pool.execute(`
                SELECT COUNT(*) AS total,
                       COALESCE(SUM(is_deleted = FALSE), 0) AS active,
                       COALESCE(SUM(is_deleted = TRUE), 0) AS deleted,
                       COALESCE(SUM(is_deleted IS NULL), 0) AS unknown_status
                FROM patients
            `);
        const allReportsResponse = await fetch(
          `${baseUrl}/admin/reports?range=all`,
        );
        assert.equal(allReportsResponse.status, 200);
        const allReportsHtml = await allReportsResponse.text();
        const metric = (html, id) => {
          const match = html.match(new RegExp(`id="${id}">([\\d,]+)<`));
          assert.ok(match, `Report metric ${id} was not rendered`);
          return Number(match[1].replaceAll(',', ''));
        };
        assert.equal(
          metric(allReportsHtml, 'reportActivePatients'),
          Number(statusRows[0].active),
        );
        assert.equal(
          metric(allReportsHtml, 'reportDeletedPatients'),
          Number(statusRows[0].deleted),
        );
        assert.equal(
          metric(allReportsHtml, 'reportUnknownPatients'),
          Number(statusRows[0].unknown_status),
        );

        const patientListResponse = await fetch(
          `${baseUrl}/patients?status=active&pageSize=100`,
        );
        assert.equal(patientListResponse.status, 200);
        const patientListHtml = await patientListResponse.text();
        const activeListMatch = patientListHtml.match(
          /Showing <strong>(\d+)<\/strong> matching record\(s\) of <strong>(\d+)<\/strong>/,
        );
        assert.ok(
          activeListMatch,
          'Patient management total count was not rendered',
        );
        assert.equal(
          metric(allReportsHtml, 'reportActivePatients'),
          Number(activeListMatch[1]),
        );

        const restored = await fetch(
          `${baseUrl}/patients/restore/${records[3].id}`,
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ version: 1 }),
          },
        );
        assert.equal(restored.status, 200);
        assert.equal((await restored.json()).success, true);
        const [restoredStatusRows] = await pool.execute(`
                SELECT COALESCE(SUM(is_deleted = FALSE), 0) AS active,
                       COALESCE(SUM(is_deleted = TRUE), 0) AS deleted
                FROM patients
            `);
        const restoredReportsResponse = await fetch(
          `${baseUrl}/admin/reports?range=all`,
        );
        const restoredReportsHtml = await restoredReportsResponse.text();
        assert.equal(
          metric(restoredReportsHtml, 'reportActivePatients'),
          Number(restoredStatusRows[0].active),
        );
        assert.equal(
          metric(restoredReportsHtml, 'reportDeletedPatients'),
          Number(restoredStatusRows[0].deleted),
        );

        const todayReportsResponse = await fetch(
          `${baseUrl}/admin/reports?range=today`,
        );
        assert.equal(todayReportsResponse.status, 200);
        const todayReportsHtml = await todayReportsResponse.text();
        const [[todayActive]] = await pool.execute(
          'SELECT COUNT(*) AS total FROM patients WHERE is_deleted = FALSE AND created_at >= ? AND created_at < ?',
          [
            `${today} 00:00:00`,
            `${tomorrow.toISOString().slice(0, 10)} 00:00:00`,
          ],
        );
        assert.equal(
          metric(todayReportsHtml, 'reportNewPatients'),
          Number(todayActive.total),
        );
        assert.match(todayReportsHtml, /Generated/);
        assert.match(todayReportsHtml, /UTC/);
        assert.match(todayReportsHtml, /Server-recorded synchronization/);
        assert.match(todayReportsHtml, /Local queue on this browser/);
        const [[syncExpected]] = await pool.execute(
          `
                SELECT COUNT(*) AS events,
                       COALESCE(SUM(success = TRUE), 0) AS successful,
                       COALESCE(SUM(success = FALSE AND conflict_detected = TRUE), 0) AS partial,
                       COALESCE(SUM(success = FALSE AND COALESCE(conflict_detected, FALSE) = FALSE), 0) AS failed
                FROM sync_logs
                WHERE synced_at >= ? AND synced_at < ?
            `,
          [
            `${today} 00:00:00`,
            `${tomorrow.toISOString().slice(0, 10)} 00:00:00`,
          ],
        );
        assert.equal(
          metric(todayReportsHtml, 'reportSyncEvents'),
          Number(syncExpected.events),
        );
        assert.equal(
          metric(todayReportsHtml, 'reportSyncSuccess'),
          Number(syncExpected.successful),
        );
        assert.equal(
          metric(todayReportsHtml, 'reportSyncPartial'),
          Number(syncExpected.partial),
        );
        assert.equal(
          metric(todayReportsHtml, 'reportSyncFailed'),
          Number(syncExpected.failed),
        );

        const customReportsResponse = await fetch(
          `${baseUrl}/admin/reports?range=custom&fromDate=${today}&toDate=${today}`,
        );
        assert.equal(customReportsResponse.status, 200);
        const customReportsHtml = await customReportsResponse.text();
        assert.equal(
          metric(customReportsHtml, 'reportNewPatients'),
          Number(todayActive.total),
        );
        assert.match(customReportsHtml, /Apply filters/);
        assert.match(customReportsHtml, /href="\/admin\/reports\?range=30d">Reset/);
        assert.match(customReportsHtml, /Export registrations for this period \(CSV\)/);
        const csvResponse = await fetch(
          `${baseUrl}/admin/reports/registrations.csv?range=custom&fromDate=${today}&toDate=${today}`,
        );
        assert.equal(csvResponse.status, 200);
        assert.equal(csvResponse.headers.get('X-Exported-Records'), String(todayActive.total));
        const csv = await csvResponse.text();
        assert.match(csv, new RegExp(`${token}-report-boundary-0`));
        assert.match(csv, new RegExp(`${token}-report-boundary-3`));
        assert.doesNotMatch(csv, new RegExp(`${token}-report-boundary-1`));
        assert.doesNotMatch(csv, new RegExp(`${token}-report-boundary-2`));

        const staffCsvResponse = await fetch(
          `${baseUrl}/admin/reports/registrations.csv?range=all`,
          { headers: { 'x-test-role': 'staff' } },
        );
        assert.equal(staffCsvResponse.status, 403);

        const emptyRange = await fetch(
          `${baseUrl}/admin/reports?range=custom&fromDate=1900-01-01&toDate=1900-01-01`,
        );
        assert.equal(emptyRange.status, 200);
        const emptyHtml = await emptyRange.text();
        assert.match(
          emptyHtml,
          /No active patient registrations matched this date range/,
        );
        assert.equal(metric(emptyHtml, 'reportNewPatients'), 0);

        const invalidRange = await fetch(
          `${baseUrl}/admin/reports?range=custom&fromDate=2026-02-30&toDate=2026-03-01`,
        );
        assert.equal(invalidRange.status, 400);
        assert.match(
          await invalidRange.text(),
          /Choose valid start and end dates/,
        );

        const reversedRange = await fetch(
          `${baseUrl}/admin/reports?range=custom&fromDate=2026-03-02&toDate=2026-03-01`,
        );
        assert.equal(reversedRange.status, 400);
        assert.match(
          await reversedRange.text(),
          /start date must be on or before/,
        );

        const forbiddenReports = await fetch(
          `${baseUrl}/admin/reports?range=all`,
          {
            headers: { 'x-test-role': 'staff' },
          },
        );
        assert.equal(forbiddenReports.status, 403);
      },
    );
  } finally {
    if (patientIds.length) {
      const placeholders = patientIds.map(() => '?').join(', ');
      await pool.execute(
        `DELETE FROM security_audit_log WHERE target_id IN (${placeholders})`,
        patientIds,
      );
      await pool.execute(
        `DELETE FROM patient_visit_events WHERE patient_id IN (${placeholders})`,
        patientIds,
      );
      await pool.execute(
        `DELETE v FROM patient_visit_vitals v
         INNER JOIN patient_visits pv ON pv.id = v.visit_id
         WHERE pv.patient_id IN (${placeholders})`,
        patientIds,
      );
      await pool.execute(
        `DELETE FROM patient_visits WHERE patient_id IN (${placeholders})`,
        patientIds,
      );
      await pool.execute(
        `DELETE FROM patient_notes WHERE patient_id IN (${placeholders})`,
        patientIds,
      );
      await pool.execute(
        `DELETE FROM patient_activity WHERE patient_id IN (${placeholders})`,
        patientIds,
      );
      await pool.execute(
        `DELETE FROM sync_operations WHERE patient_id IN (${placeholders})`,
        patientIds,
      );
      await pool.execute(
        `DELETE FROM patients WHERE id IN (${placeholders})`,
        patientIds,
      );
    }
    if (userIds.length) {
      const placeholders = userIds.map(() => '?').join(', ');
      await pool.execute(
        `DELETE FROM users WHERE id IN (${placeholders})`,
        userIds,
      );
    }
    if (server)
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await pool.end();
  }
});
