const pool = require('./local_db');

async function addSyncLogs() {
    let connection;
    try {
        connection = await pool.getConnection();
        console.log('Connected to database.');

        await connection.query(`
            CREATE TABLE IF NOT EXISTS sync_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(36), -- Since users.id is UUID string
                operation_count INT DEFAULT 0,
                synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('sync_logs table created or already exists.');

        process.exit(0);
    } catch (err) {
        console.error('Error creating sync_logs:', err);
        process.exit(1);
    } finally {
        if (connection) connection.release();
    }
}

addSyncLogs();
