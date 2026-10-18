'use strict';

const { createHash } = require('node:crypto');

const DEMO_MARKER = 'SYNTHETIC DEMO';
const DEMO_DATABASE = 'healthsys_demo';
const PATIENT_COUNT = 24;
const VISITS_PER_PATIENT = 2;

function deterministicUuid(label) {
  const hex = createHash('sha256')
    .update(`healthsys-demo-v1:${label}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function createDemoData() {
  const givenNames = [
    'Avery',
    'Jordan',
    'Morgan',
    'Riley',
    'Casey',
    'Taylor',
    'Cameron',
    'Quinn',
    'Skyler',
    'Drew',
    'Reese',
    'Rowan',
  ];
  const familyNames = [
    'Carter',
    'Bennett',
    'Hayes',
    'Morgan',
    'Reed',
    'Parker',
    'Brooks',
    'Foster',
    'Ellis',
    'Bailey',
    'Harper',
    'Rivers',
  ];
  const administrator = {
    id: deterministicUuid('user:admin'),
    username: 'demo-admin',
    role: 'admin',
  };
  const clinician = {
    id: deterministicUuid('user:clinician'),
    username: 'demo-clinician',
    role: 'staff',
  };
  const patients = Array.from({ length: PATIENT_COUNT }, (_, index) => {
    const number = index + 1;
    const patientId = deterministicUuid(`patient:${number}`);
    const gender = ['female', 'male', 'other'][index % 3];
    const visits = Array.from(
      { length: VISITS_PER_PATIENT },
      (_, visitIndex) => {
        const visitNumber = visitIndex + 1;
        return {
          visitDate: addDays('2025-01-06', index * 5 + visitIndex * 19),
          visitType:
            visitIndex === 0 ? 'Synthetic review' : 'Synthetic follow-up',
          reason: `${DEMO_MARKER}: visit ${visitNumber} · not for clinical use`,
          notes: `${DEMO_MARKER}: fictional encounter note ${visitNumber}.`,
          assessment: `${DEMO_MARKER}: example assessment only.`,
          diagnosis: `${DEMO_MARKER}: no real diagnosis.`,
          treatmentPlan: `${DEMO_MARKER}: example plan only.`,
          status: 'completed',
          vitals: {
            systolic: 108 + (index % 13),
            diastolic: 68 + (index % 11),
            pulse: 62 + (index % 23),
            temperature: Number((36.2 + (index % 6) / 10).toFixed(1)),
            respiratoryRate: 13 + (index % 6),
            oxygenSaturation: 95 + (index % 6),
            height: Number((148 + (index % 21) * 1.7).toFixed(2)),
            weight: Number((48 + (index % 20) * 1.1).toFixed(2)),
          },
        };
      },
    );
    return {
      id: patientId,
      fullName: `${DEMO_MARKER} ${givenNames[index % givenNames.length]} ${familyNames[Math.floor(index / 2) % familyNames.length]} ${String(number).padStart(3, '0')}`,
      dateOfBirth: addDays('1980-01-01', index * 420),
      gender,
      phone: `+1555${String(number).padStart(7, '0')}`,
      address: `${DEMO_MARKER} ${number} Example Street, Demo City`,
      emergencyContactName: `${DEMO_MARKER} CONTACT ${String(number).padStart(3, '0')}`,
      emergencyContactPhone: `+1556${String(number).padStart(7, '0')}`,
      emergencyContactRelationship: 'Fictional contact',
      allergies: `${DEMO_MARKER}: allergy status unspecified.`,
      medicalHistory: `${DEMO_MARKER}: fictional record; not for clinical use.`,
      medications: `${DEMO_MARKER}: no real medication information.`,
      lastModifiedBy: administrator.id,
      visits,
    };
  });
  return { administrator, clinician, patients };
}

function assertDemoDatabase(databaseName) {
  if (databaseName !== DEMO_DATABASE) {
    throw new Error(
      `Demo seeding is restricted to the explicitly named ${DEMO_DATABASE} database.`,
    );
  }
}

module.exports = {
  DEMO_DATABASE,
  DEMO_MARKER,
  PATIENT_COUNT,
  VISITS_PER_PATIENT,
  assertDemoDatabase,
  createDemoData,
  deterministicUuid,
};
