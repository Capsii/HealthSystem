const pool = require('./db');

(async () => {
    const [rows] = await pool.execute('SELECT * FROM patients WHERE is_deleted = FALSE');
    console.log(rows);
})();