const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 72;

function normalizeUsername(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function validateUsername(value) {
    const username = normalizeUsername(value);
    if (!USERNAME_PATTERN.test(username)) {
        return {
            username,
            error: 'Username must be 3-32 characters using letters, numbers, periods, underscores, or hyphens.'
        };
    }
    return { username, normalized: username.toLowerCase(), error: null };
}

function validatePassword(value) {
    if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) {
        return 'Password must be at least 12 characters long.';
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
        return 'Password must be no more than 72 bytes.';
    }

    const characterGroups = [
        /[a-z]/.test(value),
        /[A-Z]/.test(value),
        /[0-9]/.test(value),
        /[^A-Za-z0-9]/.test(value)
    ].filter(Boolean).length;
    if (characterGroups < 3) {
        return 'Password must include at least three of: lowercase, uppercase, number, or symbol.';
    }
    return null;
}

module.exports = { normalizeUsername, validateUsername, validatePassword };
