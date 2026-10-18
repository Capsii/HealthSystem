const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { getDatabaseConfig } = require('./config');
const database = getDatabaseConfig();

const pool = mysql.createPool({
  ...database,
  dateStrings: true,

  ssl: {
    ca: fs.readFileSync(path.join(__dirname, 'cert', 'isrgrootx1.pem')),
  },
});

module.exports = pool;
