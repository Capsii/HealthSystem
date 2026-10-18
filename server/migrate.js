const pool = require('./db');

const migrations = [
  {
    id: '001_patient_management',
    run: require('./migrate_patient_management'),
  },
  { id: '002_staff_security', run: require('./migrate_staff_security') },
  { id: '003_security_audit', run: require('./migrate_security_audit') },
  { id: '004_sync_idempotency', run: require('./migrate_sync_idempotency') },
  { id: '005_sync_logs', run: require('./migrate_sync_logs') },
  { id: '006_appointments', run: require('./migrate_appointments') },
  { id: '007_patient_encounters', run: require('./migrate_patient_encounters') },
  { id: '008_patient_query_indexes', run: require('./migrate_patient_query_indexes') },
];

async function runMigrations({
  executor = pool,
  migrationList = migrations,
} = {}) {
  await executor.execute(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            migration_id VARCHAR(100) NOT NULL PRIMARY KEY,
            applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

  for (const migration of migrationList) {
    const [applied] = await executor.execute(
      'SELECT migration_id FROM schema_migrations WHERE migration_id = ?',
      [migration.id],
    );
    if (applied.length) continue;

    await migration.run();
    await executor.execute(
      'INSERT INTO schema_migrations (migration_id) VALUES (?)',
      [migration.id],
    );
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => console.info('HealthSys database migrations are up to date.'))
    .catch((error) => {
      console.error(
        'HealthSys migration failed:',
        error.code || 'MIGRATION_ERROR',
      );
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { runMigrations };
