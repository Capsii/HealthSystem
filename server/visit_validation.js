const { isDateOnly, todayDateOnly } = require('./patient_validation');

const TEXT_LIMITS = {
  visit_type: 100,
  reason: 2000,
  notes: 10000,
  assessment: 10000,
  diagnosis: 5000,
  treatment_plan: 10000,
};

const VITAL_RANGES = {
  systolic_mmhg: [40, 300, 0],
  diastolic_mmhg: [20, 200, 0],
  pulse_bpm: [20, 300, 0],
  temperature_celsius: [25, 45, 1],
  respiratory_rate_per_minute: [4, 80, 0],
  oxygen_saturation_percent: [40, 100, 1],
  height_cm: [20, 250, 2],
  weight_kg: [0.2, 500, 2],
};

function textValue(value, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length <= TEXT_LIMITS[field] ? normalized : null;
}

function normalizeVitals(input) {
  const result = {};
  for (const [field, [minimum, maximum, precision]] of Object.entries(
    VITAL_RANGES,
  )) {
    const raw = input[field];
    if (raw === undefined || raw === null || raw === '') {
      result[field] = null;
      continue;
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      return { error: `${field.replaceAll('_', ' ')} must be a number.` };
    }
    const value = String(raw).trim();
    const pattern =
      precision === 0
        ? /^\d{1,3}$/
        : new RegExp(`^\\d{1,3}(?:\\.\\d{1,${precision}})?$`);
    const number = Number(value);
    if (
      !pattern.test(value) ||
      !Number.isFinite(number) ||
      number < minimum ||
      number > maximum
    ) {
      return {
        error: `${field.replaceAll('_', ' ')} must be between ${minimum} and ${maximum}${precision ? ` with at most ${precision} decimal places` : ''}.`,
      };
    }
    result[field] = number;
  }
  if (
    (result.systolic_mmhg === null) !==
    (result.diastolic_mmhg === null)
  ) {
    return { error: 'Enter both systolic and diastolic blood pressure.' };
  }
  return { value: result };
}

function normalizeVisitInput(input, { today = todayDateOnly() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Visit details are required.' };
  }
  const visitDate =
    typeof input.visit_date === 'string' ? input.visit_date.trim() : '';
  if (!isDateOnly(visitDate) || visitDate > today) {
    return { error: 'Enter a valid visit date that is not in the future.' };
  }
  const values = {};
  for (const field of Object.keys(TEXT_LIMITS)) {
    values[field] = textValue(input[field], field);
    if (values[field] === null) {
      return {
        error: `${field.replaceAll('_', ' ')} exceeds the allowed length or is not text.`,
      };
    }
  }
  const status =
    input.status === undefined || input.status === ''
      ? 'completed'
      : input.status;
  if (!['in_progress', 'completed'].includes(status)) {
    return { error: 'Select a valid visit status.' };
  }
  const vitals = normalizeVitals(input);
  if (vitals.error) return vitals;
  return {
    value: {
      visitDate,
      ...values,
      status,
      vitals: vitals.value,
    },
  };
}

function isVisitId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
}

module.exports = {
  TEXT_LIMITS,
  VITAL_RANGES,
  isVisitId,
  normalizeVisitInput,
};
