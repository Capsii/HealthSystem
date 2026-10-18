const crypto = require('node:crypto');
const { isDateOnly, isUuid } = require('./patient_validation');

const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 240;

function normalizeAppointmentInput(input, { now = new Date(), allowPast = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Appointment details are required.' };
  }

  const patientId = String(input.patient_id || '').trim();
  const staffId = String(input.assigned_staff_id || '').trim();
  const date = String(input.appointment_date || '').trim();
  const time = String(input.start_time || '').trim();
  const duration = Number(input.duration_minutes);
  const reason = String(input.reason || '').trim();
  const operationId = String(input.operation_id || '').trim();

  if (!isUuid(patientId)) return { error: 'Select a valid patient.' };
  if (!isUuid(staffId)) return { error: 'Select a valid assigned staff member.' };
  if (!isUuid(operationId)) return { error: 'Refresh the form and try again.' };
  if (!isDateOnly(date)) return { error: 'Enter a valid appointment date.' };
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return { error: 'Enter a valid 24-hour appointment time.' };
  }
  if (
    !Number.isSafeInteger(duration) ||
    duration < MIN_DURATION_MINUTES ||
    duration > MAX_DURATION_MINUTES ||
    duration % 5 !== 0
  ) {
    return { error: 'Appointment duration must be 5 to 240 minutes in 5-minute increments.' };
  }
  if (reason.length > 500) return { error: 'Appointment purpose must be 500 characters or fewer.' };

  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const startMs = Date.UTC(year, month - 1, day, hour, minute);
  const start = new Date(startMs);
  if (
    start.getUTCFullYear() !== year ||
    start.getUTCMonth() !== month - 1 ||
    start.getUTCDate() !== day
  ) {
    return { error: 'Enter a real appointment date.' };
  }
  if (!allowPast && startMs <= now.getTime()) {
    return { error: 'Appointments must be scheduled for a future time (UTC).' };
  }
  if (!Number.isFinite(startMs + duration * 60_000)) {
    return { error: 'Appointment end time is invalid.' };
  }

  const startAt = `${date} ${time}:00`;
  const endAt = new Date(startMs + duration * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const payload = {
    patientId,
    assignedStaffId: staffId,
    startAt,
    durationMinutes: duration,
    reason,
  };
  return {
    value: {
      ...payload,
      endAt,
      operationId,
      payloadHash: crypto
        .createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex'),
    },
  };
}

function isAllowedDuration(value) {
  const duration = Number(value);
  return (
    Number.isSafeInteger(duration) &&
    duration >= MIN_DURATION_MINUTES &&
    duration <= MAX_DURATION_MINUTES &&
    duration % 5 === 0
  );
}

module.exports = {
  MAX_DURATION_MINUTES,
  MIN_DURATION_MINUTES,
  isAllowedDuration,
  normalizeAppointmentInput,
};
