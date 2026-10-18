const pool = require('./local_db');

async function migrate() {
    try {
        await pool.execute('ALTER TABLE patients ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE');
        console.log('Migration successful: Added is_deleted column');
        process.exit(0);
    } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
            console.log('Column already exists');
        } else {
            console.error('Migration failed:', err);
        }
        process.exit(1);
    }
}

migrate();
