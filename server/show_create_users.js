const pool = require('./local_db');

async function showCreateTable() {
    try {
        const [rows] = await pool.query('SHOW CREATE TABLE users');
        console.log(rows[0]['Create Table']);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

showCreateTable();
