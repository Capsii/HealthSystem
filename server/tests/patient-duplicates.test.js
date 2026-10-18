const assert = require('node:assert/strict');
const test = require('node:test');
const {
  duplicateLockKeys,
  findPotentialDuplicates,
  lockDuplicateKeys,
} = require('../patient_duplicates');
const { getPatientCompletenessWarnings } = require('../patient_completeness');

test('duplicate lock keys are stable, sorted hashes that do not expose patient fields', () => {
  const patient = {
    full_name: ' Synthetic Person ',
    date_of_birth: '1990-01-02',
    phone: '+15555550123',
  };
  const first = duplicateLockKeys(patient);
  assert.deepEqual(first, duplicateLockKeys(patient));
  assert.equal(first.length, 2);
  assert.ok(first.every((key) => /^[0-9a-f]{64}$/.test(key)));
  assert.ok(first.every((key) => !key.includes('Synthetic')));
});

test('duplicate checks lock deterministic keys and merge matching reasons', async () => {
  const calls = [];
  const connection = {
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT lock_key')) {
        return [params.map((lock_key) => ({ lock_key }))];
      }
      if (sql.includes('phone = ?')) {
        return [[{
          id: '11111111-1111-4111-8111-111111111111',
          full_name: 'Synthetic Person',
          date_of_birth: '1990-01-02',
          phone: '+15555550123',
        }]];
      }
      if (sql.includes('LOWER(TRIM(full_name))')) {
        return [[{
          id: '11111111-1111-4111-8111-111111111111',
          full_name: 'Synthetic Person',
          date_of_birth: '1990-01-02',
          phone: '+15555550123',
        }, {
          id: '22222222-2222-4222-8222-222222222222',
          full_name: 'Synthetic Person',
          date_of_birth: '1990-01-02',
          phone: '+15555550999',
        }]];
      }
      return [{ affectedRows: 1 }];
    },
  };
  const patient = {
    full_name: 'Synthetic Person',
    date_of_birth: '1990-01-02',
    phone: '+15555550123',
  };

  await lockDuplicateKeys(connection, patient);
  const matches = await findPotentialDuplicates(connection, patient);
  assert.equal(calls.filter((call) => call.sql.includes('INSERT IGNORE')).length, 2);
  assert.deepEqual(matches[0].reasons, ['phone', 'name_and_date_of_birth']);
  assert.deepEqual(matches[1].reasons, ['name_and_date_of_birth']);
  assert.doesNotMatch(calls[0].sql, /Synthetic Person|15555550123/);
  assert.match(calls.find((call) => call.sql.includes('phone = ?')).sql, /LIMIT 20/);
});

test('patient completeness warnings use the required patient fields and name each omission', () => {
  assert.deepEqual(
    getPatientCompletenessWarnings({
      full_name: 'Synthetic Person',
      date_of_birth: '1990-01-02',
      gender: '',
      phone: '5555555555',
      address: 'Synthetic address',
    }),
    ['Gender'],
  );
  assert.deepEqual(getPatientCompletenessWarnings({}), [
    'Name',
    'Date of birth',
    'Gender',
    'Phone',
    'Address',
  ]);
});
