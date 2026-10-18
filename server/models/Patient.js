const { randomUUID } = require('node:crypto');
const pool = require('../db');
const repository = require('../patient_repository');
const { isUuid, normalizePatientData } = require('../patient_validation');

function normalizeOrThrow(data) {
    const result = normalizePatientData(data);
    if (result.error) throw new TypeError(result.error);
    return result.data;
}

class Patient {
    static getAll() {
        return repository.getActive(pool);
    }

    static getById(id) {
        return repository.findById(pool, id);
    }

    static async create(data) {
        const id = data?.id || randomUUID();
        if (!isUuid(id)) throw new TypeError('A valid patient UUID is required.');
        const normalized = normalizeOrThrow(data);
        await repository.create(pool, { id, data: normalized });
        return id;
    }

    static async update(id, data) {
        if (!isUuid(id)) throw new TypeError('A valid patient UUID is required.');
        const patient = await repository.findById(pool, id);
        if (!patient || patient.is_deleted) return false;
        return repository.updateIfVersion(pool, {
            id,
            data: normalizeOrThrow(data),
            expectedVersion: Number(patient.version),
        });
    }

    static async delete(id) {
        if (!isUuid(id)) throw new TypeError('A valid patient UUID is required.');
        const patient = await repository.findById(pool, id);
        if (!patient || patient.is_deleted) return false;
        return repository.updateIfVersion(pool, {
            id,
            expectedVersion: Number(patient.version),
            deleted: true,
        });
    }

    static async restore(id) {
        if (!isUuid(id)) throw new TypeError('A valid patient UUID is required.');
        const patient = await repository.findById(pool, id);
        if (!patient || !patient.is_deleted) return false;
        return repository.restoreIfVersion(pool, {
            id,
            expectedVersion: Number(patient.version),
        });
    }
}

module.exports = Patient;
