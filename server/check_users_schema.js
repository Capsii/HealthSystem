const pool = require('./local_db');

async function checkUsersSchema() {
    try {
        const [rows] = await pool.execute('DESCRIBE users');
        console.log('Current Users Schema:', rows.map(r => r.Field).join(', '));
        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

checkUsersSchema();
