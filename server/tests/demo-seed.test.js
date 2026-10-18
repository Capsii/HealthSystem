'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEMO_DATABASE,
  DEMO_MARKER,
  PATIENT_COUNT,
  VISITS_PER_PATIENT,
  assertDemoDatabase,
  createDemoData,
  deterministicUuid,
} = require('../demo_data');
const { getMode, requireOptIn } = require('../seed_demo');

test('synthetic demo data is deterministic, varied, and internally associated', () => {
  const first = createDemoData();
  const second = createDemoData();
  assert.deepEqual(first, second);
  assert.equal(first.patients.length, PATIENT_COUNT);
  assert.equal(
    first.patients.reduce((total, patient) => total + patient.visits.length, 0),
    48,
  );
  assert.equal(
    new Set(first.patients.map((patient) => patient.id)).size,
    PATIENT_COUNT,
  );
  assert.match(first.patients[0].fullName, new RegExp(`^${DEMO_MARKER}`));
  assert.equal(
    new Set(first.patients.map((patient) => patient.gender)).size,
    3,
  );
  assert.equal(
    new Set(first.patients.map((patient) => patient.phone)).size,
    PATIENT_COUNT,
  );
  assert.ok(
    first.patients.every(
      (patient) => patient.visits.length === VISITS_PER_PATIENT,
    ),
  );
  assert.ok(
    first.patients.every((patient) =>
      patient.visits.every(
        (visit) =>
          visit.notes.includes(DEMO_MARKER) &&
          visit.diagnosis.includes(DEMO_MARKER) &&
          visit.treatmentPlan.includes(DEMO_MARKER),
      ),
    ),
  );
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(first.patients.every((patient) => patient.dateOfBirth <= today));
});

test('demo IDs are stable UUIDs and the seeder rejects other databases', () => {
  assert.equal(deterministicUuid('patient:1'), deterministicUuid('patient:1'));
  assert.match(deterministicUuid('patient:1'), /^[0-9a-f-]{36}$/i);
  assert.doesNotThrow(() => assertDemoDatabase(DEMO_DATABASE));
  assert.throws(() => assertDemoDatabase('project'), /restricted/);
  assert.throws(() => assertDemoDatabase('healthsys_test'), /restricted/);
});

test('demo seeder requires explicit write and separate reset opt-ins', () => {
  const valid = {
    DB_NAME: DEMO_DATABASE,
    ALLOW_DEMO_SEED: 'true',
    DEMO_ADMIN_PASSWORD: 'DemoAdmin!Password49',
    DEMO_STAFF_PASSWORD: 'DemoStaff!Password49',
  };
  assert.equal(getMode(['--seed']), 'seed');
  assert.equal(getMode(['--reset']), 'reset');
  assert.throws(() => getMode(['--seed', '--reset']), /exactly one mode/);
  assert.doesNotThrow(() => requireOptIn('seed', valid));
  assert.throws(
    () => requireOptIn('seed', { ...valid, DB_NAME: 'project' }),
    /restricted/,
  );
  assert.throws(
    () => requireOptIn('seed', { ...valid, ALLOW_DEMO_SEED: 'false' }),
    /ALLOW_DEMO_SEED/,
  );
  assert.throws(() => requireOptIn('reset', valid), /ALLOW_DEMO_RESET/);
  assert.doesNotThrow(() =>
    requireOptIn('reset', { ...valid, ALLOW_DEMO_RESET: 'true' }),
  );
  assert.throws(
    () =>
      requireOptIn('seed', {
        ...valid,
        DEMO_ADMIN_PASSWORD: 'weak',
      }),
    /DEMO_ADMIN_PASSWORD/,
  );
});
