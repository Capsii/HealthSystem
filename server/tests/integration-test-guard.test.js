const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertIsolatedIntegrationDatabase,
} = require('./integration_test_guard');

test('integration guard rejects the configured non-test database', () => {
  const originalDatabase = process.env.DB_NAME;
  const originalOptIn = process.env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS;

  try {
    process.env.DB_NAME = 'project';
    process.env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS = 'true';
    assert.throws(assertIsolatedIntegrationDatabase, /dedicated test database/);
  } finally {
    if (originalDatabase === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = originalDatabase;
    if (originalOptIn === undefined)
      delete process.env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS;
    else process.env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS = originalOptIn;
  }
});

test('integration guard requires explicit opt-in for an isolated test database', () => {
  const originalDatabase = process.env.DB_NAME;
  const originalOptIn = process.env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS;

  try {
    process.env.DB_NAME = 'healthsys_test';
    delete process.env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS;
    assert.throws(
      assertIsolatedIntegrationDatabase,
      /ALLOW_DESTRUCTIVE_INTEGRATION_TESTS=true/,
    );
  } finally {
    if (originalDatabase === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = originalDatabase;
    if (originalOptIn === undefined)
      delete process.env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS;
    else process.env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS = originalOptIn;
  }
});

test('integration guard accepts an opted-in disposable test database', () => {
  const originalDatabase = process.env.DB_NAME;
  const originalOptIn = process.env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS;

  try {
    process.env.DB_NAME = 'healthsys_test';
    process.env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS = 'true';
    assert.doesNotThrow(assertIsolatedIntegrationDatabase);
  } finally {
    if (originalDatabase === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = originalDatabase;
    if (originalOptIn === undefined)
      delete process.env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS;
    else process.env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS = originalOptIn;
  }
});
