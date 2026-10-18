const pool = require('./local_db');

async function setup() {
    try {
        const connection = await pool.getConnection();
        console.log('Connected to database.');

        await connection.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id INT AUTO_INCREMENT PRIMARY KEY,
        full_name VARCHAR(255) NOT NULL,
        date_of_birth DATE NOT NULL,
        gender VARCHAR(50),
        phone_number VARCHAR(20),
        address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        console.log('Patients table created or already exists.');

        connection.release();
        process.exit(0);
    } catch (err) {
        console.error('Error setting up database:', err);
        process.exit(1);
    }
}

setup();
