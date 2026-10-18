const pool = require('./db');

async function migrate() {
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.query(
            'ALTER TABLE patients ADD COLUMN version INT NOT NULL DEFAULT 1'
        );
        console.log('Added patients.version.');
    } catch (error) {
        if (error.code === 'ER_DUP_FIELDNAME') {
            console.log('patients.version already exists.');
        } else {
            console.error('Concurrency migration failed:', error);
            process.exitCode = 1;
        }
    } finally {
        if (connection) connection.release();
        await pool.end();
    }
}

migrate();
