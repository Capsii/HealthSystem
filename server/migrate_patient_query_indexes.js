const pool = require('./db');

const indexes = [
  {
    name: 'idx_patients_deleted_created_id',
    columns: 'is_deleted, created_at, id',
  },
  {
    name: 'idx_patients_deleted_name_id',
    columns: 'is_deleted, full_name, id',
  },
  {
    name: 'idx_patients_deleted_dob_id',
    columns: 'is_deleted, date_of_birth, id',
  },
];

async function migrate() {
  const connection = await pool.getConnection();
  try {
    const [columns] = await connection.execute(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patients'`,
    );
    const availableColumns = new Set(
      columns.map((column) => column.COLUMN_NAME),
    );
    for (const required of [
      'id',
      'is_deleted',
      'created_at',
      'full_name',
      'date_of_birth',
    ]) {
      if (!availableColumns.has(required)) {
        throw new Error(
          `The patients table is missing required column ${required}.`,
        );
      }
    }

    const [existingIndexes] = await connection.execute(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patients'`,
    );
    const names = new Set(existingIndexes.map((index) => index.INDEX_NAME));
    for (const index of indexes) {
      if (names.has(index.name)) continue;
      await connection.query(
        `CREATE INDEX ${index.name} ON patients (${index.columns})`,
      );
    }
  } finally {
    connection.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => console.info('Patient query indexes are ready.'))
    .catch((error) => {
      console.error(
        'Patient query index migration failed:',
        error.code || error.message || 'MIGRATION_ERROR',
      );
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = migrate;
