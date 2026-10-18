const pool = require('./db');

async function getColumns(connection) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_visits'`,
  );
  return new Set(rows.map((row) => row.COLUMN_NAME));
}

async function migrate() {
  const connection = await pool.getConnection();
  try {
    const [tables] = await connection.execute(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_visits'`,
    );
    if (!tables.length) {
      throw new Error('The patient_visits table does not exist.');
    }

    const columns = await getColumns(connection);
    const additions = {
      visit_type: "VARCHAR(100) NOT NULL DEFAULT ''",
      attending_staff_id: 'VARCHAR(36) NULL',
      created_by: 'VARCHAR(36) NULL',
      updated_by: 'VARCHAR(36) NULL',
      status: "VARCHAR(20) NOT NULL DEFAULT 'completed'",
      assessment: 'TEXT NULL',
      diagnosis: 'TEXT NULL',
      treatment_plan: 'TEXT NULL',
      updated_at: 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
      version: 'INT UNSIGNED NOT NULL DEFAULT 1',
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns.has(name)) {
        await connection.query(
          `ALTER TABLE patient_visits ADD COLUMN ${name} ${definition}`,
        );
      }
    }
    const [visitIndexes] = await connection.execute(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_visits'`,
    );
    if (!visitIndexes.some((index) => index.INDEX_NAME === 'idx_visits_patient_chronology')) {
      await connection.query(
        `CREATE INDEX idx_visits_patient_chronology
         ON patient_visits (patient_id, visit_date, created_at, id)`,
      );
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS patient_visit_vitals (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        visit_id BIGINT UNSIGNED NOT NULL,
        recorded_by VARCHAR(36) NOT NULL,
        recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        systolic_mmhg SMALLINT UNSIGNED NULL,
        diastolic_mmhg SMALLINT UNSIGNED NULL,
        pulse_bpm SMALLINT UNSIGNED NULL,
        temperature_celsius DECIMAL(4,1) NULL,
        respiratory_rate_per_minute SMALLINT UNSIGNED NULL,
        oxygen_saturation_percent DECIMAL(4,1) NULL,
        height_cm DECIMAL(5,2) NULL,
        weight_kg DECIMAL(6,2) NULL,
        INDEX idx_visit_vitals_visit_recorded (visit_id, recorded_at, id),
        INDEX idx_visit_vitals_actor_recorded (recorded_by, recorded_at)
      ) ENGINE=InnoDB
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS patient_visit_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        visit_id BIGINT UNSIGNED NOT NULL,
        patient_id VARCHAR(36) NOT NULL,
        actor_id VARCHAR(36) NULL,
        event_type VARCHAR(20) NOT NULL,
        details MEDIUMTEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_visit_events_patient_time (patient_id, created_at, id),
        INDEX idx_visit_events_visit_time (visit_id, created_at, id)
      ) ENGINE=InnoDB
    `);
    console.info('Patient encounter schema is ready.');
  } finally {
    connection.release();
  }
}

if (require.main === module) {
  migrate()
    .catch((error) => {
      console.error(
        'Patient encounter migration failed:',
        error.code || error.message || 'MIGRATION_ERROR',
      );
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = migrate;
