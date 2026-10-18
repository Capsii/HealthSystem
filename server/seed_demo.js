'use strict';

require('dotenv').config({
  path: require('node:path').resolve(__dirname, '..', '.env'),
});

const bcrypt = require('bcryptjs');
const { validatePassword } = require('./staff_security');
const {
  DEMO_DATABASE,
  DEMO_MARKER,
  assertDemoDatabase,
  createDemoData,
} = require('./demo_data');

const REQUIRED_MIGRATIONS = [
  '001_patient_management',
  '002_staff_security',
  '003_security_audit',
  '004_sync_idempotency',
  '005_sync_logs',
  '006_appointments',
  '007_patient_encounters',
  '008_patient_query_indexes',
];

function getMode(argumentsList) {
  if (
    argumentsList.length !== 1 ||
    !['--seed', '--reset'].includes(argumentsList[0])
  ) {
    throw new Error('Choose exactly one mode: --seed or --reset.');
  }
  return argumentsList[0] === '--seed' ? 'seed' : 'reset';
}

function requireOptIn(mode, env = process.env) {
  if (env.DB_NAME !== DEMO_DATABASE) {
    assertDemoDatabase(env.DB_NAME);
  }
  if (env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error(
      'Set ALLOW_DEMO_SEED=true to explicitly enable demo database writes.',
    );
  }
  if (mode === 'reset' && env.ALLOW_DEMO_RESET !== 'true') {
    throw new Error(
      'Set ALLOW_DEMO_RESET=true separately to delete synthetic demo rows.',
    );
  }
  if (mode === 'seed') {
    for (const name of ['DEMO_ADMIN_PASSWORD', 'DEMO_STAFF_PASSWORD']) {
      const passwordError = validatePassword(env[name]);
      if (passwordError) throw new Error(`${name}: ${passwordError}`);
    }
  }
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

async function ensureUser(connection, user, password, createdBy) {
  const normalized = user.username.toLowerCase();
  const [existing] = await connection.execute(
    `SELECT id, username_normalized
     FROM users WHERE id = ? OR username_normalized = ?`,
    [user.id, normalized],
  );
  if (existing.length) {
    if (
      existing.length !== 1 ||
      existing[0].id !== user.id ||
      existing[0].username_normalized !== normalized
    ) {
      throw new Error(
        `Refusing to overwrite an account that conflicts with ${user.username}.`,
      );
    }
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  await connection.execute(
    `INSERT INTO users
     (id, username, username_normalized, password_hash, role, is_active,
      is_deleted, created_by, created_at, last_login)
     VALUES (?, ?, ?, ?, ?, TRUE, FALSE, ?, CURRENT_TIMESTAMP, NULL)`,
    [user.id, user.username, normalized, passwordHash, user.role, createdBy],
  );
}

async function ensurePatient(connection, patient) {
  const [existing] = await connection.execute(
    'SELECT id, full_name FROM patients WHERE id = ? FOR UPDATE',
    [patient.id],
  );
  if (existing.length) {
    if (!String(existing[0].full_name).startsWith(`${DEMO_MARKER} `)) {
      throw new Error(`Refusing to overwrite non-demo patient ${patient.id}.`);
    }
    return false;
  }
  await connection.execute(
    `INSERT INTO patients
     (id, full_name, date_of_birth, gender, phone, address, created_at, updated_at,
      is_deleted, version, last_modified_by, emergency_contact_name,
      emergency_contact_phone, emergency_contact_relationship, allergies,
      medical_history, medications)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      FALSE, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      patient.id,
      patient.fullName,
      patient.dateOfBirth,
      patient.gender,
      patient.phone,
      patient.address,
      patient.lastModifiedBy,
      patient.emergencyContactName,
      patient.emergencyContactPhone,
      patient.emergencyContactRelationship,
      patient.allergies,
      patient.medicalHistory,
      patient.medications,
    ],
  );
  await connection.execute(
    `INSERT INTO patient_activity (patient_id, user_id, action, details)
     VALUES (?, ?, 'created', ?)`,
    [
      patient.id,
      patient.lastModifiedBy,
      `${DEMO_MARKER}: patient record created; fictional data only.`,
    ],
  );
  return true;
}

function visitDetails(visit) {
  return JSON.stringify({
    syntheticDemo: true,
    after: {
      visitDate: visit.visitDate,
      visitType: visit.visitType,
      reason: visit.reason,
      notes: visit.notes,
      assessment: visit.assessment,
      diagnosis: visit.diagnosis,
      treatmentPlan: visit.treatmentPlan,
      vitals: visit.vitals,
    },
  });
}

async function ensureVisit(connection, patient, visit, clinicianId) {
  const [existing] = await connection.execute(
    `SELECT id, visit_type, status
     FROM patient_visits
     WHERE patient_id = ? AND visit_date = ? AND reason = ?`,
    [patient.id, visit.visitDate, visit.reason],
  );
  let visitId;
  if (existing.length) {
    if (
      existing.length !== 1 ||
      existing[0].visit_type !== visit.visitType ||
      existing[0].status !== visit.status
    ) {
      throw new Error(
        `Synthetic visit marker collision for patient ${patient.id}.`,
      );
    }
    visitId = existing[0].id;
  } else {
    const [result] = await connection.execute(
      `INSERT INTO patient_visits
       (patient_id, visit_date, visit_type, attending_staff_id, created_by, updated_by,
        status, reason, notes, assessment, diagnosis, treatment_plan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        patient.id,
        visit.visitDate,
        visit.visitType,
        clinicianId,
        clinicianId,
        clinicianId,
        visit.status,
        visit.reason,
        visit.notes,
        visit.assessment,
        visit.diagnosis,
        visit.treatmentPlan,
      ],
    );
    visitId = result.insertId;
  }

  const [vitals] = await connection.execute(
    'SELECT id FROM patient_visit_vitals WHERE visit_id = ?',
    [visitId],
  );
  if (vitals.length > 1) {
    throw new Error(
      `Unexpected multiple vital readings for synthetic visit ${visitId}.`,
    );
  }
  if (!vitals.length) {
    const value = visit.vitals;
    await connection.execute(
      `INSERT INTO patient_visit_vitals
       (visit_id, recorded_by, systolic_mmhg, diastolic_mmhg, pulse_bpm,
        temperature_celsius, respiratory_rate_per_minute,
        oxygen_saturation_percent, height_cm, weight_kg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        visitId,
        clinicianId,
        value.systolic,
        value.diastolic,
        value.pulse,
        value.temperature,
        value.respiratoryRate,
        value.oxygenSaturation,
        value.height,
        value.weight,
      ],
    );
  }
  const details = visitDetails(visit);
  const [events] = await connection.execute(
    `SELECT id FROM patient_visit_events
     WHERE visit_id = ? AND event_type = 'created'
       AND details LIKE ?`,
    [visitId, '%"syntheticDemo":true%'],
  );
  if (events.length > 1) {
    throw new Error(
      `Unexpected duplicate audit events for synthetic visit ${visitId}.`,
    );
  }
  if (!events.length) {
    await connection.execute(
      `INSERT INTO patient_visit_events
       (visit_id, patient_id, actor_id, event_type, details)
       VALUES (?, ?, ?, 'created', ?)`,
      [visitId, patient.id, clinicianId, details],
    );
  }
  const [activities] = await connection.execute(
    `SELECT id FROM patient_activity
     WHERE patient_id = ? AND user_id = ? AND action = 'visit recorded'
       AND details = ?`,
    [patient.id, clinicianId, `${DEMO_MARKER}: synthetic visit recorded.`],
  );
  if (activities.length > 1) {
    throw new Error(
      `Unexpected duplicate activity entries for synthetic visit ${visitId}.`,
    );
  }
  if (!activities.length) {
    await connection.execute(
      `INSERT INTO patient_activity (patient_id, user_id, action, details)
       VALUES (?, ?, 'visit recorded', ?)`,
      [patient.id, clinicianId, `${DEMO_MARKER}: synthetic visit recorded.`],
    );
  }
}

async function verifyMigrations(connection) {
  const [rows] = await connection.execute(
    'SELECT migration_id FROM schema_migrations',
  );
  const applied = new Set(rows.map((row) => row.migration_id));
  const missing = REQUIRED_MIGRATIONS.filter(
    (migration) => !applied.has(migration),
  );
  if (missing.length) {
    throw new Error(
      `Run npm run migrate first; missing: ${missing.join(', ')}.`,
    );
  }
}

async function seedDemo(connection, data) {
  await connection.beginTransaction();
  try {
    await ensureUser(
      connection,
      data.administrator,
      process.env.DEMO_ADMIN_PASSWORD,
      null,
    );
    await ensureUser(
      connection,
      data.clinician,
      process.env.DEMO_STAFF_PASSWORD,
      data.administrator.id,
    );
    for (const patient of data.patients) {
      await ensurePatient(connection, patient);
      for (const visit of patient.visits) {
        await ensureVisit(connection, patient, visit, data.clinician.id);
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function resetDemo(connection, data) {
  const patientIds = data.patients.map((patient) => patient.id);
  const userIds = [data.administrator.id, data.clinician.id];
  const patientSlots = placeholders(patientIds);
  const userSlots = placeholders(userIds);
  await connection.beginTransaction();
  try {
    const [visits] = await connection.execute(
      `SELECT id FROM patient_visits WHERE patient_id IN (${patientSlots})`,
      patientIds,
    );
    const visitIds = visits.map((visit) => visit.id);
    const [appointments] = await connection.execute(
      `SELECT id FROM appointments WHERE patient_id IN (${patientSlots})`,
      patientIds,
    );
    const appointmentIds = appointments.map((appointment) => appointment.id);
    if (appointmentIds.length) {
      await connection.execute(
        `DELETE FROM appointment_events WHERE appointment_id IN (${placeholders(appointmentIds)})`,
        appointmentIds,
      );
      await connection.execute(
        `DELETE FROM appointments WHERE id IN (${placeholders(appointmentIds)})`,
        appointmentIds,
      );
    }
    if (visitIds.length) {
      const visitSlots = placeholders(visitIds);
      await connection.execute(
        `DELETE FROM patient_visit_vitals WHERE visit_id IN (${visitSlots})`,
        visitIds,
      );
    }
    await connection.execute(
      `DELETE FROM patient_visit_events WHERE patient_id IN (${patientSlots})`,
      patientIds,
    );
    await connection.execute(
      `DELETE FROM patient_notes WHERE patient_id IN (${patientSlots})`,
      patientIds,
    );
    await connection.execute(
      `DELETE FROM patient_activity WHERE patient_id IN (${patientSlots})`,
      patientIds,
    );
    await connection.execute(
      `DELETE FROM sync_operations WHERE patient_id IN (${patientSlots})`,
      patientIds,
    );
    await connection.execute(
      `DELETE FROM sync_logs WHERE user_id IN (${userSlots})`,
      userIds,
    );
    await connection.execute(
      `DELETE FROM security_audit_log
       WHERE actor_id IN (${userSlots})
          OR target_id IN (${patientSlots}, ${userSlots})
          OR entity_id IN (${patientSlots}, ${userSlots})`,
      [...userIds, ...patientIds, ...userIds, ...patientIds, ...userIds],
    );
    await connection.execute(
      `DELETE FROM patient_visits WHERE patient_id IN (${patientSlots})`,
      patientIds,
    );
    await connection.execute(
      `DELETE FROM patients WHERE id IN (${patientSlots})`,
      patientIds,
    );
    await connection.execute('DELETE FROM users WHERE id = ?', [
      data.clinician.id,
    ]);
    await connection.execute('DELETE FROM users WHERE id = ?', [
      data.administrator.id,
    ]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function run() {
  let mode;
  try {
    mode = getMode(process.argv.slice(2));
    requireOptIn(mode);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const pool = require('./db');
  let connection;
  try {
    connection = await pool.getConnection();
    const [database] = await connection.execute('SELECT DATABASE() AS name');
    if (database[0]?.name !== process.env.DB_NAME) {
      throw new Error(
        'Connected database does not match the explicitly configured DB_NAME.',
      );
    }
    assertDemoDatabase(database[0].name);
    await verifyMigrations(connection);
    const data = createDemoData();
    if (mode === 'reset') {
      await resetDemo(connection, data);
      console.info(
        `Removed the reserved synthetic demo dataset from ${DEMO_DATABASE}.`,
      );
      return;
    }
    await seedDemo(connection, data);
    console.info(
      `Synthetic demo seed is ready: ${data.patients.length} patients, ` +
        `${data.patients.length * data.patients[0].visits.length} visits, and two demo accounts in ${DEMO_DATABASE}.`,
    );
  } catch (error) {
    console.error(
      'Synthetic demo operation failed:',
      error.code || error.message || 'DEMO_SEED_ERROR',
    );
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

if (require.main === module) run();

module.exports = {
  assertDemoDatabase,
  getMode,
  requireOptIn,
};
