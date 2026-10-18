const pool = require('./db');

async function migrate() {
    const connection = await pool.getConnection();
    try {
        await connection.query(`
            CREATE TABLE IF NOT EXISTS sync_operations (
                operation_id CHAR(36) NOT NULL PRIMARY KEY,
                payload_hash CHAR(64) NOT NULL,
                patient_id CHAR(36) NOT NULL,
                operation_type VARCHAR(10) NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_sync_operations_patient_created (patient_id, created_at)
            ) ENGINE=InnoDB
        `);
        console.log('Patient synchronization idempotency schema is ready.');
    } finally {
        connection.release();
    }
}

if (require.main === module) {
    migrate()
        .catch((error) => {
            console.error('Sync idempotency migration failed:', error.code || 'MIGRATION_ERROR');
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}

module.exports = migrate;
