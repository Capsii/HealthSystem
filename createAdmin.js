require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const pool = require('./server/db');
const { recordAudit } = require('./server/audit');
const { validatePassword } = require('./server/staff_security');

async function createAdmin() {
  const username = 'admin';
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!password) {
    throw new Error('INITIAL_ADMIN_PASSWORD must be set in the project .env file');
  }
  const passwordError = validatePassword(password);
  if (passwordError) throw new Error(passwordError);
  const role = 'admin';

  const usernameNormalized = username.toLowerCase();
  const [existing] = await pool.execute(
    'SELECT id FROM users WHERE username_normalized = ?',
    [usernameNormalized]
  );
  if (existing.length) throw new Error('An account with the initial administrator username already exists.');

  const hashedPassword = await bcrypt.hash(password, 10);

  const id = randomUUID();
  await pool.execute(
    `INSERT INTO users
     (id, username, username_normalized, password_hash, role, is_active, created_at, last_login)
     VALUES (?, ?, ?, ?, ?, TRUE, NOW(), NULL)`,
    [id, username, usernameNormalized, hashedPassword, role]
  );
  await recordAudit({ action: 'staff.bootstrap.create', targetId: id });

  console.log('Admin user created successfully!');
}

createAdmin()
  .catch(err => {
    console.error('Administrator creation failed:', err.code || 'ACCOUNT_SETUP_ERROR');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
