const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

async function loadMigration({ compatibleIds = true } = {}) {
  const databasePath = require.resolve('../db');
  const migrationPath = require.resolve('../migrate_appointments');
  const previousDatabase = require.cache[databasePath];
  const previousMigration = require.cache[migrationPath];
  const statements = [];
  const pool = {
    async getConnection() {
      return {
        async execute(sql, params) {
          if (sql.includes('information_schema.TABLES')) {
            return [[{ ENGINE: 'InnoDB' }]];
          }
          if (sql.includes('information_schema.COLUMNS')) {
            const table = params[0];
            if (!compatibleIds && table === 'patients') {
              return [[{
                COLUMN_NAME: 'id',
                COLUMN_TYPE: 'int',
                CHARACTER_SET_NAME: null,
                COLLATION_NAME: null,
              }]];
            }
            return [[{
              COLUMN_NAME: 'id',
              COLUMN_TYPE: 'varchar(36)',
              CHARACTER_SET_NAME: 'utf8mb4',
              COLLATION_NAME: 'utf8mb4_bin',
            }]];
          }
          throw new Error(`Unexpected migration query: ${sql}`);
        },
        async query(sql) {
          statements.push(sql);
        },
        release() {},
      };
    },
  };
  require.cache[databasePath] = new Module(databasePath);
  require.cache[databasePath].exports = pool;
  require.cache[databasePath].loaded = true;
  delete require.cache[migrationPath];
  const migrate = require('../migrate_appointments');
  if (previousDatabase) require.cache[databasePath] = previousDatabase;
  else delete require.cache[databasePath];
  if (previousMigration) require.cache[migrationPath] = previousMigration;
  else delete require.cache[migrationPath];
  return { migrate, statements };
}

test('appointment migration creates additive InnoDB tables with indexed, compatible foreign keys', async () => {
  const { migrate, statements } = await loadMigration();
  await migrate();
  assert.equal(statements.length, 2);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS appointments/);
  assert.match(statements[0], /ON DELETE RESTRICT/);
  assert.match(statements[0], /idx_appointments_staff_status_time/);
  assert.match(statements[1], /CREATE TABLE IF NOT EXISTS appointment_events/);
  assert.match(statements[1], /uq_appointment_events_operation/);
  assert.match(statements[1], /ON DELETE SET NULL/);
  assert.doesNotMatch(statements.join('\n'), /\bDROP\s+TABLE\b/i);
});

test('appointment migration refuses incompatible patient identifiers before creating tables', async () => {
  const { migrate, statements } = await loadMigration({ compatibleIds: false });
  await assert.rejects(migrate(), /compatible CHAR\(36\) or VARCHAR\(36\)/);
  assert.equal(statements.length, 0);
});
