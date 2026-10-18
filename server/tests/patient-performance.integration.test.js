const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const express = require('express');
const pool = require('../db');
const patientRepository = require('../patient_repository');
const patientMigration = require('../migrate_patient_management');
const staffMigration = require('../migrate_staff_security');
const auditMigration = require('../migrate_security_audit');
const encounterMigration = require('../migrate_patient_encounters');
const queryIndexMigration = require('../migrate_patient_query_indexes');
const patientRouter = require('../routes/patients');
const dashboardRouter = require('../routes/dashboard');
const adminRouter = require('../routes/admin');
const {
  assertIsolatedIntegrationDatabase,
} = require('./integration_test_guard');

const PATIENT_COUNT = 5000;
const INSERT_BATCH_SIZE = 500;
const QUERY_INDEX_NAMES = [
  'idx_patients_deleted_created_id',
  'idx_patients_deleted_name_id',
  'idx_patients_deleted_dob_id',
];

async function insertSyntheticPatients(patientIds, token) {
  for (let start = 0; start < patientIds.length; start += INSERT_BATCH_SIZE) {
    const batch = patientIds.slice(start, start + INSERT_BATCH_SIZE);
    const placeholders = batch
      .map(() => '(?, ?, ?, ?, ?, ?, FALSE, 1)')
      .join(', ');
    const values = [];
    batch.forEach((id, index) => {
      const number = start + index;
      values.push(
        id,
        `Synthetic Performance ${token} Patient ${String(number).padStart(5, '0')}`,
        `${1950 + (number % 70)}-${String((number % 12) + 1).padStart(2, '0')}-15`,
        number % 2 ? 'female' : 'male',
        `555${String(number).padStart(7, '0')}`,
        'Synthetic performance fixture',
      );
    });
    await pool.execute(
      `INSERT INTO patients
       (id, full_name, date_of_birth, gender, phone, address, is_deleted, version)
       VALUES ${placeholders}`,
      values,
    );
  }
}

async function insertSyntheticVisits(patientIds, actorId) {
  for (let start = 0; start < patientIds.length; start += INSERT_BATCH_SIZE) {
    const batch = patientIds.slice(start, start + INSERT_BATCH_SIZE);
    const values = [];
    for (const patientId of batch) {
      values.push(
        patientId,
        '2025-01-15',
        'Synthetic performance visit',
        'Synthetic performance notes',
        'Load test',
        actorId,
        actorId,
        'completed',
        'Performance assessment',
        null,
        1,
      );
      values.push(
        patientId,
        '2025-06-15',
        'Synthetic performance visit',
        'Synthetic performance notes',
        'Load test',
        actorId,
        actorId,
        'completed',
        'Performance assessment',
        null,
        1,
      );
    }
    const visitPlaceholders = batch
      .flatMap(() => [
        '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
      ])
      .join(', ');
    await pool.execute(
      `INSERT INTO patient_visits
       (patient_id, visit_date, visit_type, reason, notes, attending_staff_id,
        created_by, status, assessment, diagnosis, version, created_at)
       VALUES ${visitPlaceholders}`,
      values,
    );
  }
}

async function startServer(actor) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = {
      user: { ...actor, authVersion: 0 },
      csrfToken: 'performance-test',
    };
    next();
  });
  app.use('/patients', patientRouter);
  app.use('/dashboard', dashboardRouter);
  app.use('/admin', adminRouter);
  const server = http.createServer(app);
  const startedAt = performance.now();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    startupMs: performance.now() - startedAt,
  };
}

async function medianRequestMs(request, verifyResponse, runs = 3) {
  const values = [];
  for (let index = 0; index < runs; index++) {
    const start = performance.now();
    const response = await request();
    assert.equal(response.status, 200);
    if (verifyResponse) await verifyResponse(response);
    else await response.arrayBuffer();
    values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  return Number(values[Math.floor(values.length / 2)].toFixed(2));
}

async function explainPatientSort(sortColumn) {
  const [rows] = await pool.execute(
    `EXPLAIN SELECT id, full_name, date_of_birth, created_at
     FROM patients WHERE is_deleted = FALSE
     ORDER BY ${sortColumn} ASC, id ASC LIMIT 25`,
  );
  return rows.map((row) => ({
    operator: row.id,
    estimatedRows: row.estRows || row.rows || null,
    access: row['access object'] || row.key || '',
    details: row['operator info'] || row.Extra || '',
  }));
}

async function explainVisitHistory(patientId) {
  const [rows] = await pool.execute(
    `EXPLAIN SELECT id, patient_id, visit_date, created_at
     FROM patient_visits WHERE patient_id = ?
     ORDER BY visit_date DESC, created_at DESC, id DESC LIMIT 20`,
    [patientId],
  );
  return rows.map((row) => ({
    operator: row.id,
    estimatedRows: row.estRows || row.rows || null,
    access: row['access object'] || row.key || '',
    details: row['operator info'] || row.Extra || '',
  }));
}

async function explainCombinedSearch(token) {
  const partial = `%${token}%`;
  const [rows] = await pool.execute(
    `EXPLAIN SELECT id, full_name, date_of_birth, created_at
     FROM patients
     WHERE is_deleted = FALSE
       AND (LOWER(full_name) LIKE LOWER(?)
         OR LOWER(CAST(id AS CHAR)) LIKE LOWER(?)
         OR LOWER(phone) LIKE LOWER(?))
       AND LOWER(gender) = ?
       AND date_of_birth >= ? AND date_of_birth <= ?
     ORDER BY full_name ASC, id ASC LIMIT 25 OFFSET 0`,
    [partial, partial, partial, 'female', '1950-01-01', '2019-12-31'],
  );
  return rows.map((row) => ({
    operator: row.id,
    estimatedRows: row.estRows || row.rows || null,
    access: row['access object'] || row.key || '',
    details: row['operator info'] || row.Extra || '',
  }));
}

async function dropQueryIndexes() {
  const [rows] = await pool.execute(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patients'`,
  );
  const existing = new Set(rows.map((row) => row.INDEX_NAME));
  for (const name of QUERY_INDEX_NAMES) {
    if (existing.has(name)) {
      await pool.query(`ALTER TABLE patients DROP INDEX ${name}`);
    }
  }
}

async function getIndexNames() {
  const [rows] = await pool.execute(
    `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'patients'`,
  );
  return new Set(rows.map((row) => row.INDEX_NAME));
}

test(
  '5,000 synthetic patients and 10,000 visits exercise listing, profiles, metrics, and reports',
  { timeout: 300000 },
  async () => {
    assertIsolatedIntegrationDatabase();
    const [[database]] = await pool.execute('SELECT DATABASE() AS name');
    assert.equal(database.name, 'healthsys_test');

    const token = `load-${crypto.randomUUID().slice(0, 8)}`;
    const actorId = crypto.randomUUID();
    const patientIds = Array.from({ length: PATIENT_COUNT }, () =>
      crypto.randomUUID(),
    );
    let server;
    let userCreated = false;
    let indexesTouched = false;
    const failures = [];
    try {
      await patientMigration();
      await staffMigration();
      await auditMigration();
      await encounterMigration();
      indexesTouched = true;
      await dropQueryIndexes();

      const baselineCounts = await patientRepository.getCounts(pool);
      await pool.execute(
        `INSERT INTO users
         (id, username, username_normalized, password_hash, role,
          is_active, is_deleted, session_version)
         VALUES (?, ?, ?, 'performance-test-only', 'admin', TRUE, FALSE, 0)`,
        [actorId, `${token}-admin`, `${token}-admin`],
      );
      userCreated = true;
      await insertSyntheticPatients(patientIds, token);
      await insertSyntheticVisits(patientIds, actorId);
      await pool.query('ANALYZE TABLE patients');

      const actor = { id: actorId, username: `${token}-admin`, role: 'admin' };
      const started = await startServer(actor);
      server = started.server;
      const { baseUrl } = started;
      const encodedToken = encodeURIComponent(token.toUpperCase());
      const listUrl = `${baseUrl}/patients?search=${encodedToken}&gender=female&status=active&fromDate=1950-01-01&toDate=2019-12-31&sort=name&direction=asc&pageSize=25&page=1`;
      const sortedListUrl = `${baseUrl}/patients?status=active&sort=name&direction=asc&pageSize=25&page=1`;
      const profileUrl = `${baseUrl}/patients/${patientIds[0]}`;
      const dashboardUrl = `${baseUrl}/dashboard/metrics`;
      const reportUrl = `${baseUrl}/admin/reports?range=all`;
      const exportUrl = `${baseUrl}/admin/reports/registrations.csv?range=all`;

      const combinedFilters = await patientRepository.listPage(pool, {
        search: token,
        gender: 'female',
        status: 'active',
        fromDate: '1950-01-01',
        toDate: '2019-12-31',
        sort: 'name',
        direction: 'ASC',
        pageSize: 25,
        page: 1,
      });
      assert.equal(combinedFilters.counts.filtered, PATIENT_COUNT / 2);
      assert.equal(combinedFilters.patients.length, 25);
      assert.ok(
        combinedFilters.patients.every(
          (patient, index, patients) =>
            index === 0 ||
            patients[index - 1].full_name.localeCompare(patient.full_name) <= 0,
        ),
      );
      const secondPage = await patientRepository.listPage(pool, {
        search: token.toUpperCase(),
        gender: 'female',
        status: 'active',
        fromDate: '1950-01-01',
        toDate: '2019-12-31',
        sort: 'name',
        direction: 'ASC',
        pageSize: 25,
        page: 2,
      });
      assert.equal(secondPage.counts.filtered, combinedFilters.counts.filtered);
      assert.equal(secondPage.patients.length, 25);
      assert.notEqual(
        secondPage.patients[0].id,
        combinedFilters.patients[0].id,
      );
      assert.equal(
        Number((await patientRepository.getCounts(pool)).active),
        Number(baselineCounts.active) + PATIENT_COUNT,
      );
      const baseline = {
        combinedSearchListMs: await medianRequestMs(
          () => fetch(listUrl),
          async (response) => {
            const html = await response.text();
            assert.match(
              html,
              /Showing <strong>2500<\/strong> matching record/,
            );
          },
        ),
        sortedPatientListMs: await medianRequestMs(() => fetch(sortedListUrl)),
        profileMs: await medianRequestMs(() => fetch(profileUrl)),
        dashboardMs: await medianRequestMs(
          () => fetch(dashboardUrl),
          async (response) => {
            const body = await response.json();
            assert.equal(
              Number(body.patients.total),
              Number(baselineCounts.total) + PATIENT_COUNT,
            );
          },
        ),
        reportMs: await medianRequestMs(() => fetch(reportUrl)),
        exportMs: await medianRequestMs(
          () => fetch(exportUrl),
          async (response) => {
            assert.ok(
              Number(response.headers.get('X-Exported-Records')) >=
                PATIENT_COUNT,
            );
            await response.arrayBuffer();
          },
        ),
      };
      const profile = await (await fetch(profileUrl)).text();
      const latestVisitPosition = profile.indexOf('2025-06-15');
      const olderVisitPosition = profile.indexOf('2025-01-15');
      assert.ok(
        latestVisitPosition >= 0 && olderVisitPosition > latestVisitPosition,
      );
      const planBefore = {
        created: await explainPatientSort('created_at'),
        name: await explainPatientSort('full_name'),
        dob: await explainPatientSort('date_of_birth'),
        combinedSearch: await explainCombinedSearch(token),
        visitHistory: await explainVisitHistory(patientIds[0]),
      };
      assert.equal(
        QUERY_INDEX_NAMES.some((name) =>
          JSON.stringify(planBefore).includes(name),
        ),
        false,
      );

      await queryIndexMigration();
      await queryIndexMigration();

      const optimized = {
        combinedSearchListMs: await medianRequestMs(
          () => fetch(listUrl),
          async (response) => {
            const html = await response.text();
            assert.match(
              html,
              /Showing <strong>2500<\/strong> matching record/,
            );
          },
        ),
        sortedPatientListMs: await medianRequestMs(() => fetch(sortedListUrl)),
        profileMs: await medianRequestMs(() => fetch(profileUrl)),
        dashboardMs: await medianRequestMs(
          () => fetch(dashboardUrl),
          async (response) => {
            const body = await response.json();
            assert.equal(
              Number(body.patients.total),
              Number(baselineCounts.total) + PATIENT_COUNT,
            );
          },
        ),
        reportMs: await medianRequestMs(() => fetch(reportUrl)),
        exportMs: await medianRequestMs(
          () => fetch(exportUrl),
          async (response) => {
            assert.ok(
              Number(response.headers.get('X-Exported-Records')) >=
                PATIENT_COUNT,
            );
            await response.arrayBuffer();
          },
        ),
      };
      const planAfter = {
        created: await explainPatientSort('created_at'),
        name: await explainPatientSort('full_name'),
        dob: await explainPatientSort('date_of_birth'),
        combinedSearch: await explainCombinedSearch(token),
        visitHistory: await explainVisitHistory(patientIds[0]),
      };
      const selectedIndexes = JSON.stringify(planAfter);
      for (const name of QUERY_INDEX_NAMES) {
        assert.ok(
          selectedIndexes.includes(name),
          `Expected EXPLAIN to select ${name}.`,
        );
      }
      const installedIndexes = await getIndexNames();
      for (const name of QUERY_INDEX_NAMES) {
        assert.ok(
          installedIndexes.has(name),
          `Expected migration to install ${name}.`,
        );
      }

      console.log(
        JSON.stringify({
          database: database.name,
          syntheticPatients: PATIENT_COUNT,
          syntheticVisits: PATIENT_COUNT * 2,
          httpListenerStartupMs: Number(started.startupMs.toFixed(2)),
          withoutQueryIndexesMedianMs: baseline,
          withQueryIndexesMedianMs: optimized,
          explainBefore: planBefore,
          explainAfter: planAfter,
        }),
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      try {
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          const marks = patientIds.map(() => '?').join(', ');
          await connection.execute(
            `DELETE FROM patient_visit_events WHERE patient_id IN (${marks})`,
            patientIds,
          );
          await connection.execute(
            `DELETE v FROM patient_visit_vitals v
             INNER JOIN patient_visits pv ON pv.id = v.visit_id
             WHERE pv.patient_id IN (${marks})`,
            patientIds,
          );
          await connection.execute(
            `DELETE FROM patient_visits WHERE patient_id IN (${marks})`,
            patientIds,
          );
          await connection.execute(
            `DELETE FROM security_audit_log WHERE target_id IN (${marks})`,
            patientIds,
          );
          await connection.execute(
            `DELETE FROM patient_activity WHERE patient_id IN (${marks})`,
            patientIds,
          );
          await connection.execute(
            `DELETE FROM patients WHERE id IN (${marks})`,
            patientIds,
          );
          if (userCreated) {
            await connection.execute(
              'DELETE FROM security_audit_log WHERE actor_id = ?',
              [actorId],
            );
            await connection.execute('DELETE FROM users WHERE id = ?', [
              actorId,
            ]);
          }
          await connection.commit();
        } catch (error) {
          failures.push(error);
          try {
            await connection.rollback();
          } catch (rollbackError) {
            failures.push(rollbackError);
          }
        } finally {
          connection.release();
        }
      } catch (error) {
        failures.push(error);
      }
      if (indexesTouched) await queryIndexMigration();
    } catch (error) {
      failures.push(error);
    }
    try {
      await pool.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Performance test and cleanup failed.',
      );
    }
  },
);
