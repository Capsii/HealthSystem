const assert = require('node:assert/strict');
const test = require('node:test');
const {
    isUuid,
    normalizePatientData,
    normalizePhone,
} = require('../patient_validation');

function validPatient(overrides = {}) {
    return {
        id: '7edabf1c-0df9-4f4d-98f0-8c66ad66ca31',
        full_name: ' Synthetic Patient ',
        date_of_birth: '1990-02-28',
        gender: 'Other',
        phone: '+91 (98765) 43210',
        address: ' Synthetic address ',
        ...overrides,
    };
}

test('patient validation accepts and normalizes international and Indian phone formats', () => {
    assert.equal(normalizePhone('+91 (98765) 43210'), '+919876543210');
    assert.equal(normalizePhone('0091-98765-43210'), '+919876543210');
    assert.equal(normalizePhone('555-123-4567'), '5551234567');
    assert.equal(normalizePhone('invalid'), null);

    const result = normalizePatientData(validPatient());
    assert.equal(result.error, undefined);
    assert.equal(result.data.full_name, 'Synthetic Patient');
    assert.equal(result.data.phone, '+919876543210');
    assert.equal(result.data.address, 'Synthetic address');
});

test('patient validation rejects impossible dates, future dates, and malformed field types', () => {
    assert.match(normalizePatientData(validPatient({ date_of_birth: '2023-02-29' })).error, /date of birth/);
    assert.match(normalizePatientData(validPatient({ date_of_birth: '2999-01-01' })).error, /date of birth/);
    assert.match(normalizePatientData(validPatient({ allergies: { script: true } })).error, /must be text/);
    assert.match(normalizePatientData(validPatient({ phone: '123' })).error, /phone number/);
});

test('patient identifiers accept UUIDs and reject placeholders', () => {
    assert.equal(isUuid(validPatient().id), true);
    for (const value of ['?', 'null', 'undefined', '', null]) {
        assert.equal(isUuid(value), false);
    }
});
