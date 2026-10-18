const { createHash } = require('node:crypto');

function duplicateLockKeys(data) {
    const normalizedName = String(data.full_name || '').trim().toLowerCase();
    const dateOfBirth = String(data.date_of_birth || '');
    const phone = String(data.phone || '').trim();
    const candidates = [`phone:${phone}`, `name-dob:${normalizedName}\u0000${dateOfBirth}`];
    return [...new Set(candidates.map((value) =>
        createHash('sha256').update(value).digest('hex'),
    ))].sort();
}

async function lockDuplicateKeys(connection, data) {
    const keys = duplicateLockKeys(data);
    for (const key of keys) {
        await connection.execute(
            'INSERT IGNORE INTO patient_duplicate_locks (lock_key) VALUES (?)',
            [key],
        );
    }
    const placeholders = keys.map(() => '?').join(', ');
    const [locked] = await connection.execute(
        `SELECT lock_key FROM patient_duplicate_locks
         WHERE lock_key IN (${placeholders}) ORDER BY lock_key FOR UPDATE`,
        keys,
    );
    if (locked.length !== keys.length) {
        throw new Error('Patient duplicate checks could not be serialized.');
    }
}

async function findPotentialDuplicates(connection, data) {
    const [phoneMatches] = await connection.execute(
        `SELECT id, full_name, date_of_birth, phone
         FROM patients WHERE is_deleted = FALSE AND phone = ?
        ORDER BY created_at DESC, id DESC LIMIT 20 FOR UPDATE`,
        [data.phone],
    );
    const [nameMatches] = await connection.execute(
        `SELECT id, full_name, date_of_birth, phone
         FROM patients
         WHERE is_deleted = FALSE AND date_of_birth = ?
           AND LOWER(TRIM(full_name)) = LOWER(?)
         ORDER BY created_at DESC, id DESC LIMIT 20 FOR UPDATE`,
        [data.date_of_birth, data.full_name.trim()],
    );
    const matches = new Map();
    for (const [rows, reason] of [
        [phoneMatches, 'phone'],
        [nameMatches, 'name_and_date_of_birth'],
    ]) {
        for (const patient of rows) {
            const match = matches.get(patient.id) || {
                id: patient.id,
                full_name: patient.full_name,
                date_of_birth: patient.date_of_birth,
                phone: patient.phone,
                reasons: [],
            };
            if (!match.reasons.includes(reason)) match.reasons.push(reason);
            matches.set(patient.id, match);
        }
    }
    return [...matches.values()].sort((left, right) =>
        String(left.full_name).localeCompare(String(right.full_name)),
    );
}

module.exports = { duplicateLockKeys, findPotentialDuplicates, lockDuplicateKeys };
