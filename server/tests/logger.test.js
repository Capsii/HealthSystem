const assert = require('node:assert/strict');
const test = require('node:test');
const logger = require('../logger');

test('structured logger only emits allowlisted operational fields', () => {
  const originalInfo = console.info;
  let output;
  console.info = (line) => {
    output = JSON.parse(line);
  };
  try {
    logger.info('patient.lookup.failed', {
      requestId: 'synthetic-request-id',
      errorCode: 'DATABASE_ERROR',
      patientName: 'Synthetic patient',
      databasePassword: 'not-for-logs',
      status: 500,
      port: Number.MAX_SAFE_INTEGER + 1,
    });
  } finally {
    console.info = originalInfo;
  }

  assert.equal(output.event, 'patient.lookup.failed');
  assert.equal(output.requestId, 'synthetic-request-id');
  assert.equal(output.errorCode, 'DATABASE_ERROR');
  assert.equal(output.status, 500);
  assert.equal(Object.hasOwn(output, 'patientName'), false);
  assert.equal(Object.hasOwn(output, 'databasePassword'), false);
  assert.equal(Object.hasOwn(output, 'port'), false);
});
