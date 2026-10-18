const assert = require('node:assert/strict');
const test = require('node:test');
const repository = require('../patient_repository');

function makeExecutor({ rows = [], affectedRows = 1 } = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (sql.trimStart().startsWith('SELECT')) return [rows];
      return [{ affectedRows }];
    },
  };
}

test('patient repository creates normalized allowlisted fields and actor metadata', async () => {
  const executor = makeExecutor();
  const data = {
    full_name: 'Synthetic patient',
    date_of_birth: '1990-01-01',
    gender: 'other',
    phone: '+15551234567',
    address: 'Synthetic address',
    emergency_contact_name: '',
    emergency_contact_phone: '',
    emergency_contact_relationship: '',
    allergies: '',
    medical_history: '',
    medications: '',
    untrusted: 'must not be persisted',
  };
  await repository.create(executor, {
    id: '12345678-1234-4234-8234-123456789abc',
    data,
    actorId: '22345678-1234-4234-8234-123456789abc',
  });

  assert.match(executor.calls[0].sql, /INSERT INTO patients/);
  assert.match(executor.calls[0].sql, /last_modified_by/);
  assert.equal(executor.calls[0].params.includes(data.untrusted), false);
  assert.equal(executor.calls[0].params.length, 13);
});

test('patient repository performs an optimistic update with active-record and version guards', async () => {
  const executor = makeExecutor({ affectedRows: 0 });
  const data = {
    full_name: 'Synthetic update',
    date_of_birth: '1990-01-01',
    gender: 'other',
    phone: '5551234567',
    address: 'Updated address',
    emergency_contact_name: '',
    emergency_contact_phone: '',
    emergency_contact_relationship: '',
    allergies: '',
    medical_history: '',
    medications: '',
  };
  const updated = await repository.updateIfVersion(executor, {
    id: '12345678-1234-4234-8234-123456789abc',
    data,
    actorId: '22345678-1234-4234-8234-123456789abc',
    expectedVersion: 7,
  });

  assert.equal(updated, false);
  assert.match(executor.calls[0].sql, /version = version \+ 1/);
  assert.match(
    executor.calls[0].sql,
    /WHERE id = \? AND version = \? AND is_deleted = FALSE/,
  );
  assert.equal(
    executor.calls[0].params.at(-2),
    '12345678-1234-4234-8234-123456789abc',
  );
  assert.equal(executor.calls[0].params.at(-1), 7);
});

test('patient repository reports missing and found rows consistently', async () => {
  const patient = { id: '12345678-1234-4234-8234-123456789abc' };
  const found = makeExecutor({ rows: [patient] });
  const missing = makeExecutor();

  assert.equal(await repository.findById(found, patient.id), patient);
  assert.equal(await repository.findById(missing, patient.id), null);
});

test('patient repository can lock the current row when returning a conflict snapshot', async () => {
  const executor = makeExecutor({
    rows: [{ id: '12345678-1234-4234-8234-123456789abc' }],
  });
  await repository.findById(executor, '12345678-1234-4234-8234-123456789abc', {
    forUpdate: true,
  });
  assert.match(executor.calls[0].sql, /WHERE id = \? FOR UPDATE$/);
});

test('patient repository builds a bound combined-filter query and validates pagination identifiers', async () => {
  const calls = [];
  const executor = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)')) return [[{ total: '13' }]];
      return [[{ id: '12345678-1234-4234-8234-123456789abc' }]];
    },
  };
  const result = await repository.listPage(executor, {
    search: 'synthetic',
    gender: 'female',
    status: 'active',
    fromDate: '1980-01-01',
    toDate: '2000-01-01',
    sort: 'name',
    direction: 'ASC',
    pageSize: 10,
    page: 2,
  });

  assert.equal(result.counts.total, 13);
  assert.equal(result.counts.filtered, 13);
  assert.deepEqual(result.pagination, { page: 2, pageSize: 10, pages: 2 });
  assert.deepEqual(calls[1].params, [
    '%synthetic%',
    '%synthetic%',
    '%synthetic%',
    'female',
    '1980-01-01',
    '2000-01-01',
  ]);
  assert.deepEqual(calls[2].params, [
    '%synthetic%',
    '%synthetic%',
    '%synthetic%',
    'female',
    '1980-01-01',
    '2000-01-01',
  ]);
  assert.match(
    calls[2].sql,
    /ORDER BY full_name ASC, id ASC LIMIT 10 OFFSET 10/,
  );
  await assert.rejects(
    repository.listPage(executor, { sort: 'name; DROP TABLE patients' }),
    /Unsupported patient sort field/,
  );
});

test('patient repository uses shared status aggregation for dashboards and reports', async () => {
  const executor = {
    async execute(sql) {
      assert.match(sql, /unknown_status/);
      return [
        [
          {
            total: '4',
            active: '2',
            deleted: '1',
            unknown_status: '1',
          },
        ],
      ];
    },
  };

  assert.deepEqual(await repository.getCounts(executor), {
    total: 4,
    active: 2,
    deleted: 1,
  });
  assert.deepEqual(await repository.getStatusCounts(executor), {
    total: 4,
    active: 2,
    deleted: 1,
    unknown_status: 1,
  });
});
