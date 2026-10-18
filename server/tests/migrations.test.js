const assert = require('node:assert/strict');
const test = require('node:test');
const { runMigrations } = require('../migrate');

function migrationExecutor(initial = []) {
  const applied = new Set(initial);
  return {
    applied,
    async execute(sql, params = []) {
      if (sql.includes('SELECT migration_id')) {
        return [applied.has(params[0]) ? [{ migration_id: params[0] }] : []];
      }
      if (sql.includes('INSERT INTO schema_migrations')) {
        applied.add(params[0]);
      }
      return [{ affectedRows: 1 }];
    },
  };
}

test('migration runner records completed versions and safely skips recorded migrations', async () => {
  const executor = migrationExecutor(['001_existing']);
  const calls = [];
  const migrations = [
    { id: '001_existing', run: async () => calls.push('existing') },
    { id: '002_new', run: async () => calls.push('new') },
  ];

  await runMigrations({ executor, migrationList: migrations });
  await runMigrations({ executor, migrationList: migrations });

  assert.deepEqual(calls, ['new']);
  assert.deepEqual(Array.from(executor.applied), ['001_existing', '002_new']);
});

test('migration runner does not mark a failed migration as applied', async () => {
  const executor = migrationExecutor();
  const migrations = [
    {
      id: '001_failure',
      async run() {
        throw new Error('synthetic migration failure');
      },
    },
  ];

  await assert.rejects(
    runMigrations({ executor, migrationList: migrations }),
    /synthetic migration failure/,
  );
  assert.equal(executor.applied.has('001_failure'), false);
});
