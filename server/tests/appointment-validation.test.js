const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeAppointmentInput } = require('../appointment_validation');

const patientId = '1221b6a0-9014-47c7-8b10-e66311acd821';
const staffId = '7edabf1c-0df9-4f4d-98f0-8c66ad66ca31';
const operationId = '63cbfb08-d5b1-47a5-a7eb-e3bd15d37adb';

function validInput(overrides = {}) {
  return {
    patient_id: patientId,
    assigned_staff_id: staffId,
    appointment_date: '2030-02-28',
    start_time: '14:30',
    duration_minutes: '30',
    reason: 'Synthetic follow-up',
    operation_id: operationId,
    ...overrides,
  };
}

test('normalizes a future appointment to explicit UTC start and end timestamps', () => {
  const result = normalizeAppointmentInput(validInput(), {
    now: new Date('2030-01-01T00:00:00.000Z'),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.value.startAt, '2030-02-28 14:30:00');
  assert.equal(result.value.endAt, '2030-02-28 15:00:00');
  assert.equal(result.value.payloadHash.length, 64);
  assert.equal(result.value.operationId, operationId);
});

test('rejects impossible dates, malformed UTC times, and past appointments', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');
  assert.match(
    normalizeAppointmentInput(validInput({ appointment_date: '2030-02-30' }), {
      now,
    }).error,
    /valid appointment date/,
  );
  assert.match(
    normalizeAppointmentInput(validInput({ start_time: '24:00' }), { now })
      .error,
    /24-hour/,
  );
  assert.match(
    normalizeAppointmentInput(
      validInput({ appointment_date: '2029-12-31', start_time: '23:59' }),
      { now },
    ).error,
    /future time \(UTC\)/,
  );
});

test('requires valid patient, staff, and operation IDs', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');
  for (const [override, expected] of [
    [{ patient_id: 'unknown' }, /valid patient/],
    [{ assigned_staff_id: 'unknown' }, /assigned staff/],
    [{ operation_id: 'unknown' }, /Refresh the form/],
  ]) {
    assert.match(
      normalizeAppointmentInput(validInput(override), { now }).error,
      expected,
    );
  }
});

test('enforces duration bounds and five-minute increments', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');
  for (const duration of ['0', '7', '245', '1.5', 'invalid']) {
    assert.match(
      normalizeAppointmentInput(
        validInput({ duration_minutes: duration }),
        { now },
      ).error,
      /duration/,
    );
  }
});

test('limits purpose text and trims accepted input', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');
  assert.match(
    normalizeAppointmentInput(validInput({ reason: 'x'.repeat(501) }), {
      now,
    }).error,
    /500 characters/,
  );
  assert.equal(
    normalizeAppointmentInput(validInput({ reason: '  Follow-up  ' }), {
      now,
    }).value.reason,
    'Follow-up',
  );
});
