const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const pool = require('../db');
const patientMigration = require('../migrate_patient_management');
const staffMigration = require('../migrate_staff_security');
const auditMigration = require('../migrate_security_audit');
const appointmentsMigration = require('../migrate_appointments');
const encounterMigration = require('../migrate_patient_encounters');
const patientsRouter = require('../routes/patients');
const appointmentsRouter = require('../routes/appointments');
const { assertIsolatedIntegrationDatabase } = require('./integration_test_guard');

function makeBookingInput({
  patientId,
  staffId,
  date,
  time,
  operationId = crypto.randomUUID(),
  reason = 'Synthetic appointment integration test',
} = {}) {
  return {
    patient_id: patientId,
    assigned_staff_id: staffId,
    appointment_date: date,
    start_time: time,
    duration_minutes: '30',
    reason,
    operation_id: operationId,
  };
}

function futureSlot(daysAhead = 7, hour = 14) {
  const value = new Date(Date.now() + daysAhead * 86_400_000);
  value.setUTCHours(hour, 0, 0, 0);
  return {
    date: value.toISOString().slice(0, 10),
    time: value.toISOString().slice(11, 16),
  };
}

test('appointment management database integration', async (t) => {
  const token = `appt-${crypto.randomUUID().slice(0, 8)}`;
  const adminId = crypto.randomUUID();
  const staffOneId = crypto.randomUUID();
  const staffTwoId = crypto.randomUUID();
  const userIds = [adminId, staffOneId, staffTwoId];
  const patientIds = [];
  let server;
  let baseUrl;
  let isolatedDatabaseConfirmed = false;

  try {
    assertIsolatedIntegrationDatabase();
    isolatedDatabaseConfirmed = true;
    await patientMigration();
    await staffMigration();
    await auditMigration();
    await encounterMigration();
    await appointmentsMigration();
    for (const [index, user] of userIds.entries()) {
      await pool.execute(
        `INSERT INTO users
         (id, username, username_normalized, password_hash, role,
          is_active, is_deleted, session_version)
         VALUES (?, ?, ?, ?, ?, TRUE, FALSE, 0)`,
        [
          user,
          `${token}-${index}`,
          `${token}-${index}`,
          'integration-only',
          index === 0 ? 'admin' : 'staff',
        ],
      );
    }

    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '..', 'views'));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req, _res, next) => {
      const actorId =
        req.get('x-test-actor') === 'staff-one'
          ? staffOneId
          : req.get('x-test-actor') === 'staff-two'
            ? staffTwoId
            : adminId;
      const role = actorId === adminId ? 'admin' : 'staff';
      req.session = {
        csrfToken: 'appointment-test-csrf-token',
        user: { id: actorId, username: `${token}-${userIds.indexOf(actorId)}`, role, authVersion: 0 },
      };
      if (req.get('x-test-anonymous') === 'true') req.session = null;
      if (req.get('x-test-no-csrf') !== 'true') {
        req.headers['x-csrf-token'] = 'appointment-test-csrf-token';
      }
      next();
    });
    app.use('/patients', patientsRouter);
    app.use('/appointments', appointmentsRouter);
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    async function createPatient(name) {
      const id = crypto.randomUUID();
      patientIds.push(id);
      await pool.execute(
        `INSERT INTO patients (id, full_name, date_of_birth, gender, phone, address)
         VALUES (?, ?, '1990-01-01', 'other', ?, 'Synthetic appointment test')`,
        [id, `${name} ${token}`, `+1555${String(patientIds.length).padStart(7, '0')}`],
      );
      return id;
    }

    async function post(pathname, values, actor = 'admin') {
      return fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'x-test-actor': actor,
        },
        body: new URLSearchParams(values),
      });
    }

    async function schedule(patientId, staffId, slot, extras = {}, actor = 'admin') {
      return post(
        '/appointments/create',
        makeBookingInput({ patientId, staffId, ...slot, ...extras }),
        actor,
      );
    }

    await t.test('rejects invalid dates, missing patients, and invalid staff references', async () => {
      const patientId = await createPatient('Validation patient');
      const slot = futureSlot();
      const invalidDate = await schedule(
        patientId,
        staffOneId,
        { ...slot, date: '2030-02-30' },
      );
      assert.equal(invalidDate.status, 400);

      const missingPatient = await schedule(crypto.randomUUID(), staffOneId, slot);
      assert.equal(missingPatient.status, 404);

      const missingStaff = await schedule(patientId, crypto.randomUUID(), slot);
      assert.equal(missingStaff.status, 403);

      const csrfRejected = await fetch(`${baseUrl}/appointments/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'x-test-no-csrf': 'true',
        },
        body: new URLSearchParams(makeBookingInput({
          patientId,
          staffId: staffOneId,
          ...futureSlot(8),
        })),
      });
      assert.equal(csrfRejected.status, 403);

      const unauthenticated = await fetch(`${baseUrl}/appointments`, {
        headers: { 'x-test-anonymous': 'true', Accept: 'application/json' },
      });
      assert.equal(unauthenticated.status, 401);
    });

    await t.test('schedules once for a repeated operation ID and exposes it on the patient profile', async () => {
      const patientId = await createPatient('Idempotent patient');
      const slot = futureSlot(9);
      const input = makeBookingInput({
        patientId,
        staffId: staffOneId,
        ...slot,
      });
      const first = await post('/appointments/create', input);
      const firstResult = await first.json();
      assert.equal(first.status, 200);
      assert.equal(firstResult.success, true);

      const duplicate = await post('/appointments/create', input);
      const duplicateResult = await duplicate.json();
      assert.equal(duplicate.status, 200);
      assert.equal(duplicateResult.appointmentId, firstResult.appointmentId);
      const [[counts]] = await pool.execute(
        `SELECT
           (SELECT COUNT(*) FROM appointments WHERE id = ?) AS appointments,
           (SELECT COUNT(*) FROM appointment_events WHERE operation_id = ?) AS events`,
        [firstResult.appointmentId, input.operation_id],
      );
      assert.equal(Number(counts.appointments), 1);
      assert.equal(Number(counts.events), 1);

      const profile = await fetch(`${baseUrl}/patients/${patientId}`);
      assert.equal(profile.status, 200);
      assert.match(await profile.text(), /Synthetic appointment integration test/);
    });

    await t.test('reschedules with history, cancels without deleting, and releases the slot', async () => {
      const patientId = await createPatient('Lifecycle patient');
      const firstSlot = futureSlot(11);
      const scheduled = await schedule(patientId, staffOneId, firstSlot);
      const { appointmentId } = await scheduled.json();
      assert.equal(scheduled.status, 200);

      const secondSlot = futureSlot(12);
      const rescheduleInput = {
        ...makeBookingInput({
          patientId,
          staffId: staffOneId,
          ...secondSlot,
          reason: 'Synthetic rescheduled purpose',
        }),
        version: '1',
      };
      const rescheduled = await post(
        `/appointments/${appointmentId}/reschedule`,
        rescheduleInput,
      );
      assert.equal(rescheduled.status, 200);
      const repeatedReschedule = await post(
        `/appointments/${appointmentId}/reschedule`,
        rescheduleInput,
      );
      assert.equal(repeatedReschedule.status, 200);

      const cancelInput = {
        version: '2',
        operation_id: crypto.randomUUID(),
      };
      const cancelled = await post(`/appointments/${appointmentId}/cancel`, {
        ...cancelInput,
      });
      assert.equal(cancelled.status, 200);
      const repeatedCancellation = await post(
        `/appointments/${appointmentId}/cancel`,
        cancelInput,
      );
      assert.equal(repeatedCancellation.status, 200);
      const [[appointment]] = await pool.execute(
        'SELECT status, version FROM appointments WHERE id = ?',
        [appointmentId],
      );
      assert.equal(appointment.status, 'cancelled');
      assert.equal(Number(appointment.version), 3);
      const [[eventCount]] = await pool.execute(
        'SELECT COUNT(*) AS total FROM appointment_events WHERE appointment_id = ?',
        [appointmentId],
      );
      assert.equal(Number(eventCount.total), 3);

      const replacement = await schedule(
        await createPatient('Replacement patient'),
        staffOneId,
        secondSlot,
      );
      assert.equal(replacement.status, 200);
      const cancelledList = await fetch(
        `${baseUrl}/appointments?status=cancelled&fromDate=${secondSlot.date}&toDate=${secondSlot.date}&staff=${staffOneId}`,
      );
      assert.equal(cancelledList.status, 200);
      assert.match(await cancelledList.text(), /Synthetic rescheduled purpose/);
    });

    await t.test('rejects overlapping bookings even when requests arrive concurrently', async () => {
      const slot = futureSlot(14);
      const patients = await Promise.all([
        createPatient('Concurrent one'),
        createPatient('Concurrent two'),
      ]);
      const results = await Promise.all([
        schedule(patients[0], staffTwoId, slot),
        schedule(patients[1], staffTwoId, slot),
      ]);
      assert.deepEqual(
        results.map((result) => result.status).sort(),
        [200, 409],
      );
      const [[count]] = await pool.execute(
        `SELECT COUNT(*) AS total FROM appointments
         WHERE assigned_staff_id = ? AND start_at = ? AND status = 'scheduled'`,
        [staffTwoId, `${slot.date} ${slot.time}:00`],
      );
      assert.equal(Number(count.total), 1);
    });

    await t.test('marks elapsed appointments completed or missed and filters both statuses', async () => {
      const patientIdsForStatuses = [
        await createPatient('Completed patient'),
        await createPatient('Missed patient'),
      ];
      const past = new Date(Date.now() - 2 * 86_400_000);
      past.setUTCHours(10, 0, 0, 0);
      const startAt = `${past.toISOString().slice(0, 10)} 10:00:00`;
      const appointmentIds = [crypto.randomUUID(), crypto.randomUUID()];
      for (let index = 0; index < appointmentIds.length; index++) {
        await pool.execute(
          `INSERT INTO appointments
           (id, patient_id, assigned_staff_id, created_by, start_at,
            duration_minutes, reason, status, version)
           VALUES (?, ?, ?, ?, ?, 30, ?, 'scheduled', 1)`,
          [
            appointmentIds[index],
            patientIdsForStatuses[index],
            staffOneId,
            adminId,
            startAt,
            `Synthetic ${index === 0 ? 'completed' : 'missed'} appointment`,
          ],
        );
      }
      const completed = await post(
        `/appointments/${appointmentIds[0]}/complete`,
        { version: '1', operation_id: crypto.randomUUID() },
      );
      const missed = await post(
        `/appointments/${appointmentIds[1]}/missed`,
        { version: '1', operation_id: crypto.randomUUID() },
      );
      assert.equal(completed.status, 200);
      assert.equal(missed.status, 200);

      for (const status of ['completed', 'missed']) {
        const filtered = await fetch(`${baseUrl}/appointments?status=${status}`);
        assert.equal(filtered.status, 200);
        assert.match(await filtered.text(), new RegExp(`Synthetic ${status} appointment`));
      }
    });

    await t.test('staff cannot view or modify another staff member’s appointments', async () => {
      const patientId = await createPatient('Permission patient');
      const slot = futureSlot(16);
      const scheduled = await schedule(patientId, staffTwoId, slot);
      const { appointmentId } = await scheduled.json();

      const ownPatientId = await createPatient('Staff self-assignment patient');
      const ownAssignment = await schedule(
        ownPatientId,
        staffTwoId,
        futureSlot(17),
        {},
        'staff-one',
      );
      assert.equal(ownAssignment.status, 200);
      const ownAssignmentResult = await ownAssignment.json();
      const [[ownAppointment]] = await pool.execute(
        'SELECT assigned_staff_id FROM appointments WHERE id = ?',
        [ownAssignmentResult.appointmentId],
      );
      assert.equal(ownAppointment.assigned_staff_id, staffOneId);

      const forbiddenCancel = await post(
        `/appointments/${appointmentId}/cancel`,
        { version: '1', operation_id: crypto.randomUUID() },
        'staff-one',
      );
      assert.equal(forbiddenCancel.status, 403);

      const hiddenFromList = await fetch(`${baseUrl}/appointments?search=${patientId}`, {
        headers: { 'x-test-actor': 'staff-one' },
      });
      assert.equal(hiddenFromList.status, 200);
      assert.doesNotMatch(await hiddenFromList.text(), /Permission patient/);
    });

    await t.test('audit failure rolls back the new appointment and its history event', async () => {
      const patientId = await createPatient('Rollback patient');
      const slot = futureSlot(18);
      const input = makeBookingInput({
        patientId,
        staffId: staffOneId,
        ...slot,
      });
      const originalGetConnection = pool.getConnection;
      pool.getConnection = async function getConnectionWithAuditFailure() {
        const connection = await originalGetConnection.call(pool);
        return {
          async execute(sql, params) {
            if (/INSERT INTO security_audit_log/i.test(sql)) {
              const error = new Error('Synthetic audit insert failure');
              error.code = 'TEST_INJECTED_FAILURE';
              throw error;
            }
            return connection.execute(sql, params);
          },
          beginTransaction: (...args) => connection.beginTransaction(...args),
          commit: (...args) => connection.commit(...args),
          rollback: (...args) => connection.rollback(...args),
          release: (...args) => connection.release(...args),
        };
      };
      let result;
      try {
        result = await post('/appointments/create', input);
      } finally {
        pool.getConnection = originalGetConnection;
      }
      assert.equal(result.status, 500);
      const [[counts]] = await pool.execute(
        `SELECT
           (SELECT COUNT(*) FROM appointments WHERE patient_id = ?) AS appointments,
           (SELECT COUNT(*) FROM appointment_events WHERE operation_id = ?) AS events`,
        [patientId, input.operation_id],
      );
      assert.equal(Number(counts.appointments), 0);
      assert.equal(Number(counts.events), 0);
    });
  } finally {
    if (isolatedDatabaseConfirmed && patientIds.length) {
      const placeholders = patientIds.map(() => '?').join(', ');
      const [rows] = await pool.execute(
        `SELECT id FROM appointments WHERE patient_id IN (${placeholders})`,
        patientIds,
      );
      if (rows.length) {
        const appointmentIds = rows.map((row) => row.id);
        const appointmentPlaceholders = appointmentIds.map(() => '?').join(', ');
        await pool.execute(
          `DELETE FROM appointment_events WHERE appointment_id IN (${appointmentPlaceholders})`,
          appointmentIds,
        );
        await pool.execute(
          `DELETE FROM appointments WHERE id IN (${appointmentPlaceholders})`,
          appointmentIds,
        );
      }
      await pool.execute(
        `DELETE FROM security_audit_log WHERE target_id IN (${placeholders})`,
        patientIds,
      );
      await pool.execute(
        `DELETE FROM patient_activity WHERE patient_id IN (${placeholders})`,
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
        `DELETE FROM patients WHERE id IN (${placeholders})`,
        patientIds,
      );
    }
    if (isolatedDatabaseConfirmed && userIds.length) {
      const placeholders = userIds.map(() => '?').join(', ');
      await pool.execute(
        `DELETE FROM security_audit_log WHERE actor_id IN (${placeholders})`,
        userIds,
      );
      await pool.execute(
        `DELETE FROM users WHERE id IN (${placeholders})`,
        userIds,
      );
    }
    if (server) {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await pool.end();
  }
});
