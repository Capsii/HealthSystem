const pool = require('./db');

function compatibleIdColumn(column) {
  if (
    !column ||
    !/^(?:char|varchar)\(36\)$/i.test(column.COLUMN_TYPE || '') ||
    (column.CHARACTER_SET_NAME &&
      !/^[a-zA-Z0-9_]+$/.test(column.CHARACTER_SET_NAME)) ||
    (column.COLLATION_NAME && !/^[a-zA-Z0-9_]+$/.test(column.COLLATION_NAME))
  ) {
    return null;
  }
  return [
    column.COLUMN_TYPE.toUpperCase(),
    column.CHARACTER_SET_NAME
      ? `CHARACTER SET ${column.CHARACTER_SET_NAME}`
      : '',
    column.COLLATION_NAME ? `COLLATE ${column.COLLATION_NAME}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

async function getTableDetails(connection, tableName) {
  const [tables] = await connection.execute(
    `SELECT ENGINE FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName],
  );
  if (!tables.length) throw new Error(`The ${tableName} table does not exist.`);
  const [columns] = await connection.execute(
    `SELECT COLUMN_NAME, COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'id'`,
    [tableName],
  );
  return { engine: tables[0].ENGINE, id: columns[0] };
}

async function migrate() {
  const connection = await pool.getConnection();
  try {
    const patients = await getTableDetails(connection, 'patients');
    const users = await getTableDetails(connection, 'users');
    const patientIdType = compatibleIdColumn(patients.id);
    const userIdType = compatibleIdColumn(users.id);
    if (!patientIdType || !userIdType) {
      throw new Error(
        'Appointments require patient and user IDs stored as compatible CHAR(36) or VARCHAR(36) columns.',
      );
    }

    const canReferencePatients =
      String(patients.engine).toLowerCase() === 'innodb';
    const canReferenceUsers = String(users.engine).toLowerCase() === 'innodb';
    const patientForeignKey = canReferencePatients
      ? ', CONSTRAINT fk_appointments_patient FOREIGN KEY (patient_id) REFERENCES patients (id) ON DELETE RESTRICT'
      : '';
    const staffForeignKeys = canReferenceUsers
      ? `,
        CONSTRAINT fk_appointments_staff FOREIGN KEY (assigned_staff_id) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT fk_appointments_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT`
      : '';

    await connection.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        patient_id ${patientIdType} NOT NULL,
        assigned_staff_id ${userIdType} NOT NULL,
        created_by ${userIdType} NOT NULL,
        start_at DATETIME NOT NULL COMMENT 'UTC',
        duration_minutes SMALLINT UNSIGNED NOT NULL,
        reason VARCHAR(500) NOT NULL DEFAULT '',
        status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
        version INT UNSIGNED NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_appointments_staff_status_time (assigned_staff_id, status, start_at),
        INDEX idx_appointments_patient_time (patient_id, start_at),
        INDEX idx_appointments_status_time (status, start_at)
        ${patientForeignKey}
        ${staffForeignKeys}
      ) ENGINE=InnoDB
    `);

    const appointmentForeignKey =
      ', CONSTRAINT fk_appointment_events_appointment FOREIGN KEY (appointment_id) REFERENCES appointments (id) ON DELETE RESTRICT';
    const actorForeignKey = canReferenceUsers
      ? ', CONSTRAINT fk_appointment_events_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL'
      : '';
    await connection.query(`
      CREATE TABLE IF NOT EXISTS appointment_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        appointment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        actor_id ${userIdType} NULL,
        event_type VARCHAR(20) NOT NULL,
        operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        details TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE INDEX uq_appointment_events_operation (operation_id),
        INDEX idx_appointment_events_history (appointment_id, created_at, id)
        ${appointmentForeignKey}
        ${actorForeignKey}
      ) ENGINE=InnoDB
    `);
    console.info('Appointment management schema is ready.');
  } finally {
    connection.release();
  }
}

if (require.main === module) {
  migrate()
    .catch((error) => {
      console.error(
        'Appointment migration failed:',
        error.code || error.message || 'MIGRATION_ERROR',
      );
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = migrate;
