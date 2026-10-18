const path = require('node:path');
const dotenv = require('dotenv');
const { parseHttpsOrigin, parseTrustProxy } = require('./transport_security');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function requiredEnv(name, env = process.env) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be configured in the environment.`);
  }
  return value.trim();
}

function parsePort(value, name) {
  if (!/^\d+$/.test(String(value)))
    throw new Error(`${name} must be a valid port number.`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a valid port number.`);
  }
  return port;
}

function getAppConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  return {
    sessionSecret: requiredEnv('SESSION_SECRET', env),
    port:
      env.PORT === undefined || env.PORT === ''
        ? 3000
        : parsePort(env.PORT, 'PORT'),
    isProduction,
    httpsRedirectOrigin: isProduction
      ? parseHttpsOrigin(requiredEnv('HTTPS_REDIRECT_ORIGIN', env))
      : null,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}

function getDatabaseConfig(env = process.env) {
  return {
    host: requiredEnv('DB_HOST', env),
    port: parsePort(requiredEnv('DB_PORT', env), 'DB_PORT'),
    user: requiredEnv('DB_USER', env),
    password: requiredEnv('DB_PASSWORD', env),
    database: requiredEnv('DB_NAME', env),
  };
}

module.exports = { getAppConfig, getDatabaseConfig, parsePort, requiredEnv };
