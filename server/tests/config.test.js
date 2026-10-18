const assert = require('node:assert/strict');
const test = require('node:test');
const { getAppConfig, getDatabaseConfig, parsePort } = require('../config');

test('configuration validates application and database ports', () => {
  assert.equal(parsePort('3443', 'PORT'), 3443);
  assert.throws(() => parsePort('0', 'PORT'), /valid port number/);
  assert.throws(() => parsePort('3e3', 'PORT'), /valid port number/);
  assert.throws(() => parsePort('65536', 'PORT'), /valid port number/);
});

test('application config requires session secret and production HTTPS origin', () => {
  assert.throws(() => getAppConfig({}), /SESSION_SECRET/);
  assert.throws(
    () =>
      getAppConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: 'synthetic-test-secret',
      }),
    /HTTPS_REDIRECT_ORIGIN/,
  );
  const config = getAppConfig({
    NODE_ENV: 'development',
    SESSION_SECRET: 'synthetic-test-secret',
    PORT: '3100',
  });
  assert.equal(config.port, 3100);
  assert.equal(config.isProduction, false);
  assert.equal(config.httpsRedirectOrigin, null);
});

test('database config reports missing required settings without exposing values', () => {
  assert.throws(
    () => getDatabaseConfig({ DB_HOST: 'synthetic-host' }),
    /DB_PORT/,
  );
  assert.deepEqual(
    getDatabaseConfig({
      DB_HOST: 'synthetic-host',
      DB_PORT: '4000',
      DB_USER: 'synthetic-user',
      DB_PASSWORD: 'synthetic-password',
      DB_NAME: 'project',
    }),
    {
      host: 'synthetic-host',
      port: 4000,
      user: 'synthetic-user',
      password: 'synthetic-password',
      database: 'project',
    },
  );
});
