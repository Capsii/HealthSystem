const crypto = require('node:crypto');
const { PATIENT_FIELDS } = require('./patient_validation');

function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${stableSerialize(value[key])}`
        ).join(',')}}`;
    }
    return JSON.stringify(value);
}

function operationPayloadHash(type, table, data) {
    let payload = data;
    if (table === 'patients' && data && typeof data === 'object') {
        payload = { id: data.id };
        if (type !== 'ADD') payload.version = Number(data.version);
        if (type === 'ADD' || type === 'EDIT') {
            for (const field of PATIENT_FIELDS) payload[field] = data[field] ?? '';
        }
    }
    return crypto.createHash('sha256').update(stableSerialize({ type, table, data: payload })).digest('hex');
}

module.exports = { operationPayloadHash };
