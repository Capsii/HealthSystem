const pool = require('./db');

const auditColumns = {
    actor_role: 'VARCHAR(20) NULL',
    entity_type: 'VARCHAR(40) NULL',
    entity_id: 'CHAR(36) NULL',
    details: 'TEXT NULL',
    operation_id: 'CHAR(36) NULL',
    failure_category: 'VARCHAR(60) NULL',
};

async function migrate() {
    const connection = await pool.getConnection();
    try {
        await connection.query(`
            CREATE TABLE IF NOT EXISTS security_audit_log (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                actor_id CHAR(36) NULL,
                action VARCHAR(80) NOT NULL,
                target_id CHAR(36) NULL,
                outcome VARCHAR(20) NOT NULL,
                request_id CHAR(36) NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_security_audit_created (created_at),
                INDEX idx_security_audit_actor_created (actor_id, created_at)
            ) ENGINE=InnoDB
        `);
        const [columns] = await connection.execute(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'security_audit_log'`,
        );
        const existingColumns = new Set(columns.map((column) => column.COLUMN_NAME));
        for (const [name, definition] of Object.entries(auditColumns)) {
            if (!existingColumns.has(name)) {
                await connection.query(
                    `ALTER TABLE security_audit_log ADD COLUMN ${name} ${definition}`,
                );
            }
        }
        const [indexes] = await connection.execute(
            `SELECT INDEX_NAME FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'security_audit_log'`,
        );
        if (!indexes.some((index) => index.INDEX_NAME === 'uq_security_audit_operation')) {
            await connection.query(
                'CREATE UNIQUE INDEX uq_security_audit_operation ON security_audit_log (operation_id)',
            );
        }
        if (!indexes.some((index) => index.INDEX_NAME === 'idx_security_audit_entity_created')) {
            await connection.query(
                'CREATE INDEX idx_security_audit_entity_created ON security_audit_log (entity_type, entity_id, created_at)',
            );
        }
        if (!indexes.some((index) => index.INDEX_NAME === 'idx_security_audit_action_outcome')) {
            await connection.query(
                'CREATE INDEX idx_security_audit_action_outcome ON security_audit_log (action, outcome, created_at)',
            );
        }
        console.log('Security audit schema is ready.');
    } finally {
        connection.release();
    }
}

if (require.main === module) {
    migrate()
        .catch((error) => {
            console.error('Security audit migration failed:', error.code || error.message);
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}

module.exports = migrate;
