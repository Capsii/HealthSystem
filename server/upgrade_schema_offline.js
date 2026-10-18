const pool = require('./local_db');

async function upgradeSchema() {
    let connection;
    try {
        connection = await pool.getConnection();
        console.log('Connected to database.');

        // 1. Upgrade 'patients' table
        try {
            await connection.query('ALTER TABLE patients ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
            console.log('Added updated_at to patients.');
        } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') console.error(e.message); }

        try {
            await connection.query('ALTER TABLE patients ADD COLUMN last_modified_by VARCHAR(36)');
            console.log('Added last_modified_by to patients.');
        } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') console.error(e.message); }

        try {
            await connection.query('ALTER TABLE patients ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE');
            console.log('Added is_deleted to patients.');
        } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') console.error(e.message); }

        try {
            await connection.query('ALTER TABLE patients ADD COLUMN device_id VARCHAR(100)');
            console.log('Added device_id to patients.');
        } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') console.error(e.message); }

        try {
            await connection.query('ALTER TABLE patients ADD COLUMN version INT NOT NULL DEFAULT 1');
            console.log('Added version to patients.');
        } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') console.error(e.message); }


        // 2. Upgrade 'users' table
        try {
            await connection.query('ALTER TABLE users ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
            console.log('Added updated_at to users.');
        } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') console.error(e.message); }

        try {
            await connection.query('ALTER TABLE users ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE');
            console.log('Added is_deleted to users.');
        } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') console.error(e.message); }

        // 3. Upgrade 'sync_logs' table (Create if missing or Alter)
        // Already created in previous step but ensure fields
        try {
            await connection.query(`
                CREATE TABLE IF NOT EXISTS sync_logs (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(36),
                    action_type VARCHAR(50),
                    success BOOLEAN,
                    conflict_detected BOOLEAN DEFAULT FALSE,
                    operation_count INT DEFAULT 0,
                    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            // If table existed, might need to add columns. 
            // Simplest approach: Add columns if missing
            try { await connection.query('ALTER TABLE sync_logs ADD COLUMN action_type VARCHAR(50)'); } catch (e) { }
            try { await connection.query('ALTER TABLE sync_logs ADD COLUMN success BOOLEAN'); } catch (e) { }
            try { await connection.query('ALTER TABLE sync_logs ADD COLUMN conflict_detected BOOLEAN DEFAULT FALSE'); } catch (e) { }

            console.log('Ensured sync_logs table structure.');

        } catch (err) {
            console.error('Error with sync_logs:', err);
        }

        console.log('Schema upgrade complete.');
        process.exit(0);
    } catch (err) {
        console.error('Fatal Error:', err);
        process.exit(1);
    } finally {
        if (connection) connection.release();
    }
}

upgradeSchema();
