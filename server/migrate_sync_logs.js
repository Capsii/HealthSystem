const pool = require('./db');

async function getColumns(connection) {
    const [rows] = await connection.execute(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_logs'`
    );
    return new Set(rows.map((row) => row.COLUMN_NAME));
}

async function migrate() {
    const connection = await pool.getConnection();
    try {
        await connection.query(`
            CREATE TABLE IF NOT EXISTS sync_logs (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(36) NULL,
                action_type VARCHAR(50) NULL,
                success BOOLEAN NULL,
                conflict_detected BOOLEAN NOT NULL DEFAULT FALSE,
                operation_count INT NOT NULL DEFAULT 0,
                synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_sync_logs_synced_at (synced_at),
                INDEX idx_sync_logs_user_synced (user_id, synced_at)
            ) ENGINE=InnoDB
        `);

        let columns = await getColumns(connection);
        if (!columns.has('id')) {
            throw new Error('Existing sync_logs table has no id column; reconcile it manually without deleting its history.');
        }
        const definitions = {
            user_id: 'VARCHAR(36) NULL',
            action_type: 'VARCHAR(50) NULL',
            success: 'BOOLEAN NULL',
            conflict_detected: 'BOOLEAN NOT NULL DEFAULT FALSE',
            operation_count: 'INT NOT NULL DEFAULT 0',
            synced_at: 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
        };
        for (const [column, definition] of Object.entries(definitions)) {
            if (!columns.has(column)) {
                await connection.query(`ALTER TABLE sync_logs ADD COLUMN ${column} ${definition}`);
            }
        }
        console.log('Synchronization history schema is ready.');
    } finally {
        connection.release();
    }
}

if (require.main === module) {
    migrate()
        .catch((error) => {
            console.error('Synchronization history migration failed:', error.code || 'MIGRATION_ERROR');
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}

module.exports = migrate;
