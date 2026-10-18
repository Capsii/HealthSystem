const bcrypt = require('bcrypt');
const pool = require('./local_db');
const { validatePassword } = require('./staff_security');

const debugPassword = process.env.DEBUG_USER_PASSWORD;
if (!debugPassword) {
    throw new Error('DEBUG_USER_PASSWORD must be set in the project .env file');
}
const passwordError = validatePassword(debugPassword);
if (passwordError) throw new Error(passwordError);

async function debugRegister() {
    try {
        console.log('Attempting to hash password...');
        const hash = await bcrypt.hash(debugPassword, 10);
        console.log('Password hashed.');

        console.log('Attempting insert...');
        const username = 'debug_user_' + Date.now();
        const [result] = await pool.execute(
            `INSERT INTO users
             (username, username_normalized, password_hash, role, is_active, last_login)
             VALUES (?, ?, ?, 'staff', TRUE, NULL)`,
            [username, username.toLowerCase(), hash]
        );
        console.log('Insert successful:', result.affectedRows);
    } catch (err) {
        console.error('Debug registration failed:', err.code || 'ACCOUNT_SETUP_ERROR');
    }
    await pool.end();
}

debugRegister();
