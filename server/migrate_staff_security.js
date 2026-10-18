const pool = require('./db');

async function getColumns(connection) {
    const [rows] = await connection.execute(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
    );
    return new Set(rows.map((row) => row.COLUMN_NAME));
}

async function getIndexes(connection) {
    const [rows] = await connection.execute(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
    );
    return new Set(rows.map((row) => row.INDEX_NAME));
}

async function migrate() {
    const connection = await pool.getConnection();
    try {
        const [tables] = await connection.execute(
            `SELECT TABLE_NAME FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
        );
        if (!tables.length) throw new Error('The users table does not exist.');

        let columns = await getColumns(connection);
        if (!columns.has('username_normalized')) {
            await connection.query(
                `ALTER TABLE users ADD COLUMN username_normalized
                 VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL`
            );
        }

        const [duplicates] = await connection.execute(`
            SELECT COUNT(*) AS duplicate_groups
            FROM (
                SELECT LOWER(TRIM(username)) AS normalized_username
                FROM users
                GROUP BY LOWER(TRIM(username))
                HAVING COUNT(*) > 1
            ) AS normalized_duplicates
        `);
        if (Number(duplicates[0].duplicate_groups) > 0) {
            throw new Error(
                'Multiple existing accounts have usernames that differ only by case or surrounding whitespace. ' +
                'Resolve those duplicates, then rerun this migration.'
            );
        }
        await connection.execute(
            'UPDATE users SET username_normalized = LOWER(TRIM(username))'
        );

        columns = await getColumns(connection);
        if (!columns.has('session_version')) {
            await connection.query(
                'ALTER TABLE users ADD COLUMN session_version INT NOT NULL DEFAULT 0'
            );
        }

        if (!columns.has('last_login')) {
            await connection.query(
                'ALTER TABLE users ADD COLUMN last_login TIMESTAMP NULL DEFAULT NULL'
            );
        } else {
            await connection.query(
                'ALTER TABLE users MODIFY COLUMN last_login TIMESTAMP NULL DEFAULT NULL'
            );
        }

        const indexes = await getIndexes(connection);
        if (!indexes.has('uq_users_username_normalized')) {
            await connection.query(
                'ALTER TABLE users ADD UNIQUE INDEX uq_users_username_normalized (username_normalized)'
            );
        }
        await connection.query(
            'ALTER TABLE users MODIFY COLUMN username_normalized VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL'
        );
        console.log('Staff security schema is ready.');
    } finally {
        connection.release();
    }
}

if (require.main === module) {
    migrate()
        .catch((error) => {
            console.error('Staff security migration failed:', error);
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}

module.exports = migrate;
