const REQUIRED_PATIENT_FIELDS = [
    ['full_name', 'Name'],
    ['date_of_birth', 'Date of birth'],
    ['gender', 'Gender'],
    ['phone', 'Phone'],
    ['address', 'Address'],
];

function getPatientCompletenessWarnings(patient) {
    return REQUIRED_PATIENT_FIELDS
        .filter(([field]) =>
            typeof patient?.[field] !== 'string' || !patient[field].trim(),
        )
        .map(([, label]) => label);
}

module.exports = { getPatientCompletenessWarnings };
