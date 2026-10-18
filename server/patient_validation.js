const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATIENT_FIELDS = [
    'full_name',
    'date_of_birth',
    'gender',
    'phone',
    'address',
    'emergency_contact_name',
    'emergency_contact_phone',
    'emergency_contact_relationship',
    'allergies',
    'medical_history',
    'medications',
];
const FIELD_LIMITS = {
    full_name: 255,
    address: 2000,
    emergency_contact_name: 255,
    emergency_contact_phone: 30,
    emergency_contact_relationship: 100,
    allergies: 10000,
    medical_history: 10000,
    medications: 10000,
};

function isUuid(value) {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

function normalizePhone(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || !/^\+?[0-9().\-\s]+$/.test(trimmed)) return null;
    let normalized = trimmed.replace(/[().\-\s]/g, '');
    if (normalized.startsWith('00')) normalized = `+${normalized.slice(2)}`;
    const digits = normalized.startsWith('+') ? normalized.slice(1) : normalized;
    if (!/^\d{7,15}$/.test(digits)) return null;
    return normalized;
}

function isDateOnly(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day;
}

function todayDateOnly() {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

function normalizePatientData(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { error: 'Patient details must be an object.' };
    }

    const data = {};
    for (const field of PATIENT_FIELDS) {
        const value = input[field];
        if (value !== undefined && value !== null && typeof value !== 'string') {
            return { error: `Patient field ${field} must be text.` };
        }
        data[field] = typeof value === 'string' ? value.trim() : '';
    }
    data.gender = data.gender.toLowerCase();
    const normalizedPhone = normalizePhone(data.phone);

    if (!data.full_name || data.full_name.length > FIELD_LIMITS.full_name) {
        return { error: 'Enter a name up to 255 characters.' };
    }
    if (!isDateOnly(data.date_of_birth) || data.date_of_birth > todayDateOnly()) {
        return { error: 'Enter a valid date of birth that is not in the future.' };
    }
    if (!['male', 'female', 'other'].includes(data.gender)) {
        return { error: 'Select a valid gender.' };
    }
    if (!normalizedPhone) {
        return { error: 'Enter a valid phone number with 7 to 15 digits.' };
    }
    data.phone = normalizedPhone;
    if (!data.address || data.address.length > FIELD_LIMITS.address) {
        return { error: 'Enter an address up to 2,000 characters.' };
    }
    for (const [field, maximum] of Object.entries(FIELD_LIMITS)) {
        if (data[field].length > maximum) {
            return { error: `Patient field ${field} exceeds ${maximum} characters.` };
        }
    }
    if (data.emergency_contact_phone) {
        const emergencyPhone = normalizePhone(data.emergency_contact_phone);
        if (!emergencyPhone) {
            return { error: 'Enter a valid emergency contact phone number.' };
        }
        data.emergency_contact_phone = emergencyPhone;
    }
    return { data };
}

module.exports = {
    FIELD_LIMITS,
    PATIENT_FIELDS,
    isDateOnly,
    isUuid,
    normalizePatientData,
    normalizePhone,
    todayDateOnly,
};
