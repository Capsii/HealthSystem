const pool = require('./db');

const patientColumns = {
    is_deleted: 'BOOLEAN NOT NULL DEFAULT FALSE',
    version: 'INT NOT NULL DEFAULT 1',
    updated_at: 'DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
    last_modified_by: 'VARCHAR(36) NULL',
    emergency_contact_name: 'VARCHAR(255) NULL',
    emergency_contact_phone: 'VARCHAR(30) NULL',
    emergency_contact_relationship: 'VARCHAR(100) NULL',
    allergies: 'TEXT NULL',
    medical_history: 'TEXT NULL',
    medications: 'TEXT NULL',
};

async function getColumns(connection, tableName) {
    const [rows] = await connection.execute(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [tableName]
    );
    return new Set(rows.map((column) => column.COLUMN_NAME));
}

async function addMissingColumns(connection, tableName, definitions) {
    const existingColumns = await getColumns(connection, tableName);
    for (const [name, definition] of Object.entries(definitions)) {
        if (!existingColumns.has(name)) {
            await connection.query(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`);
            console.log(`Added ${tableName}.${name}`);
        }
    }
}

async function migrate() {
    const connection = await pool.getConnection();
    try {
        const [tables] = await connection.execute(
            `SELECT TABLE_NAME FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patients'`
        );
        if (!tables.length) throw new Error('The patients table does not exist.');

        const requiredPatientColumns = ['id', 'full_name', 'date_of_birth', 'gender', 'phone', 'address'];
        const existingPatientColumns = await getColumns(connection, 'patients');
        const missingPatientColumns = requiredPatientColumns.filter((column) => !existingPatientColumns.has(column));
        if (missingPatientColumns.length) {
            throw new Error(
                `The existing patients table is missing required columns (${missingPatientColumns.join(', ')}). ` +
                'This migration does not rename or discard existing patient data; reconcile the legacy schema separately.'
            );
        }
        await addMissingColumns(connection, 'patients', patientColumns);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS patient_activity (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                patient_id VARCHAR(36) NOT NULL,
                user_id VARCHAR(36) NULL,
                action VARCHAR(50) NOT NULL,
                details TEXT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_patient_activity_patient_time (patient_id, created_at)
            )
        `);
        await addMissingColumns(connection, 'patient_activity', {
            patient_id: 'VARCHAR(36) NULL',
            user_id: 'VARCHAR(36) NULL',
            action: 'VARCHAR(50) NULL',
            details: 'TEXT NULL',
            created_at: 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP',
            operation_id: 'CHAR(36) NULL',
        });
        const [activityIndexes] = await connection.execute(
            `SELECT INDEX_NAME FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patient_activity'`,
        );
        if (!activityIndexes.some((index) => index.INDEX_NAME === 'uq_patient_activity_operation')) {
            await connection.query(
                'CREATE UNIQUE INDEX uq_patient_activity_operation ON patient_activity (operation_id)',
            );
        }
        await connection.query(`
            CREATE TABLE IF NOT EXISTS patient_visits (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                patient_id VARCHAR(36) NOT NULL,
                visit_date DATE NOT NULL,
                reason TEXT NULL,
                notes TEXT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_patient_visits_patient_date (patient_id, visit_date)
            )
        `);
        await addMissingColumns(connection, 'patient_visits', {
            patient_id: 'VARCHAR(36) NULL',
            visit_date: 'DATE NULL',
            reason: 'TEXT NULL',
            notes: 'TEXT NULL',
            created_at: 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP',
        });
        await connection.query(`
            CREATE TABLE IF NOT EXISTS patient_duplicate_locks (
                lock_key CHAR(64) NOT NULL PRIMARY KEY
            ) ENGINE=InnoDB
        `);
        await connection.query(`
            CREATE TABLE IF NOT EXISTS patient_notes (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                patient_id VARCHAR(36) NOT NULL,
                author_id VARCHAR(36) NOT NULL,
                note TEXT NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_patient_notes_patient_time (patient_id, created_at)
            ) ENGINE=InnoDB
        `);
        await addMissingColumns(connection, 'patient_notes', {
            patient_id: 'VARCHAR(36) NULL',
            author_id: 'VARCHAR(36) NULL',
            note: 'TEXT NULL',
            created_at: 'TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP',
        });
        console.log('Patient management schema is ready.');
    } finally {
        connection.release();
    }
}

if (require.main === module) {
    migrate()
        .catch((error) => {
            console.error('Patient management migration failed:', error);
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}

module.exports = migrate;
