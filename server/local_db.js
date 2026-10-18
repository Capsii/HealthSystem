const mysql = require('mysql2/promise');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const password = process.env.LOCAL_DB_PASSWORD;
if (!password) {
  throw new Error('LOCAL_DB_PASSWORD must be set in the project .env file');
}

module.exports = mysql.createPool({
  host: process.env.LOCAL_DB_HOST || 'localhost',
  port: Number(process.env.LOCAL_DB_PORT || 3306),
  user: process.env.LOCAL_DB_USER || 'root',
  password,
  database: process.env.LOCAL_DB_NAME || 'project',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});
