const pool = require('./local_db');

async function checkSchema() {
    try {
        const [rows] = await pool.execute('DESCRIBE patients');
        console.log('Current Schema:', rows.map(r => r.Field).join(', '));
        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

checkSchema();
