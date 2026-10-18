const pool = require('./local_db');

async function addAdminFields() {
    let connection;
    try {
        connection = await pool.getConnection();
        console.log('Connected to database.');

        // Add is_active column
        try {
            await connection.query('ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT TRUE');
            console.log('Added is_active column.');
        } catch (err) {
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log('is_active column already exists.');
            } else {
                console.error('Error adding is_active:', err);
            }
        }

        // Add created_by column
        try {
            await connection.query('ALTER TABLE users ADD COLUMN created_by VARCHAR(36)'); // UUID length
            console.log('Added created_by column.');
        } catch (err) {
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log('created_by column already exists.');
            } else {
                console.error('Error adding created_by:', err);
            }
        }

        // Add last_login - Check if exists first (from previous step it seemed to exist but good to be safe)
        try {
            await connection.query('ALTER TABLE users ADD COLUMN last_login TIMESTAMP NULL');
            console.log('Added last_login column.');
        } catch (err) {
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log('last_login column already exists.');
            } else {
                console.error('Error adding last_login:', err);
            }
        }


        console.log('Schema update complete.');
        process.exit(0);
    } catch (err) {
        console.error('Error updating schema:', err);
        process.exit(1);
    } finally {
        if (connection) connection.release();
    }
}

addAdminFields();
