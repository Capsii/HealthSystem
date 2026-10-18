const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db');
const migrate = require('../migrate_staff_security');
const migratePatients = require('../migrate_patient_management');
const migrateSecurityAudit = require('../migrate_security_audit');
const loginRouter = require('../routes/login');
const registerRouter = require('../routes/register');
const accountRouter = require('../routes/account');
const adminRouter = require('../routes/admin');
const dashboardRouter = require('../routes/dashboard');
const syncRouter = require('../routes/sync');
const { assertIsolatedIntegrationDatabase } = require('./integration_test_guard');

test('staff security database integration', async (t) => {
    assertIsolatedIntegrationDatabase();
    const token = uuidv4().replaceAll('-', '').slice(0, 8);
    const adminId = uuidv4();
    const secondAdminId = uuidv4();
    const staffId = uuidv4();
    const newUserIds = [];
    const patientIds = [];
    const users = [
        { id: adminId, username: `admin${token}`, password: 'AdminStarter!2026', role: 'admin' },
        { id: secondAdminId, username: `admin2${token}`, password: 'AdminSecond!2026', role: 'admin' },
        { id: staffId, username: `staff${token}`, password: 'StaffStarter!2026', role: 'staff' },
    ];
    const controlAdminId = adminId;
    const controlAdminVersion = 0;
    let server;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousTestAuthBypass = process.env.HEALTHSYS_TEST_AUTH_BYPASS;
    process.env.NODE_ENV = 'test';
    process.env.HEALTHSYS_TEST_AUTH_BYPASS = 'true';

    try {
        await migrate();
        await migratePatients();
        await migrateSecurityAudit();
        for (const user of users) {
            await pool.execute(
                `INSERT INTO users
                 (id, username, username_normalized, password_hash, role, is_active, is_deleted, session_version, last_login)
                 VALUES (?, ?, ?, ?, ?, TRUE, FALSE, 0, NULL)`,
                [user.id, user.username, user.username.toLowerCase(), await bcrypt.hash(user.password, 10), user.role]
            );
        }

        const app = express();
        app.set('view engine', 'ejs');
        app.set('views', path.join(__dirname, '..', 'views'));
        app.use(express.json());
        app.use(express.urlencoded({ extended: true }));
        app.use(session({
            secret: 'staff-security-test-only',
            resave: false,
            saveUninitialized: false,
        }));
        app.use((req, res, next) => {
            req.session.csrfToken = 'staff-test-csrf-token';
            const userId = req.get('x-test-user');
            if (userId) {
                req.session.user = {
                    id: userId,
                    username: 'test-user',
                    role: req.get('x-test-role') || 'admin',
                    authVersion: Number(req.get('x-test-version') || 0),
                };
            }
            next();
        });
        app.use('/', loginRouter);
        app.use('/register', registerRouter);
        app.use('/account', accountRouter);
        app.use('/dashboard', dashboardRouter);
        app.use('/admin', adminRouter);
        app.use('/sync', syncRouter);

        server = http.createServer(app);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const authHeaders = (id = adminId, version = 0, role = 'admin') => ({
            'x-test-user': id,
            'x-test-version': String(version),
            'x-test-role': role,
        });
        const controlHeaders = () => authHeaders(controlAdminId, controlAdminVersion);
        const postForm = (url, data, options = {}) => fetch(`${baseUrl}${url}`, {
            method: 'POST',
            redirect: options.redirect || 'manual',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                ...options.headers,
            },
            body: new URLSearchParams(data),
        });

        await t.test('validates account creation, case-insensitive uniqueness, and password strength', async () => {
            const page = await fetch(`${baseUrl}/admin/staff`, { headers: authHeaders() });
            assert.equal(page.status, 200);
            const pageHtml = await page.text();
            assert.match(pageHtml, /Never logged in/);
            assert.match(pageHtml, /data-password-toggle/);
            assert.match(pageHtml, /data-confirm-title="Change staff role"/);
            assert.match(pageHtml, /\/js\/ui\.js/);

            const invalidUsername = await postForm('/admin/staff', {
                _csrf: 'staff-test-csrf-token',
                username: 'bad name',
                password: 'StrongPassword!123',
                role: 'staff',
            }, { headers: authHeaders() });
            assert.equal(invalidUsername.status, 302);
            assert.match(decodeURIComponent(invalidUsername.headers.get('location')), /Username must be/);

            const weakPassword = await postForm('/admin/staff', {
                _csrf: 'staff-test-csrf-token',
                username: `weak${token}`,
                password: 'short',
                role: 'staff',
            }, { headers: authHeaders() });
            assert.equal(weakPassword.status, 302);
            assert.match(decodeURIComponent(weakPassword.headers.get('location')), /at least 12 characters/);

            const weakComposition = await postForm('/admin/staff', {
                _csrf: 'staff-test-csrf-token',
                username: `weakcomp${token}`,
                password: 'alllowercasepassword',
                role: 'staff',
            }, { headers: authHeaders() });
            assert.equal(weakComposition.status, 302);
            assert.match(decodeURIComponent(weakComposition.headers.get('location')), /at least three of/);

            const duplicate = await postForm('/admin/staff', {
                _csrf: 'staff-test-csrf-token',
                username: users[0].username.toUpperCase(),
                password: 'StrongPassword!123',
                role: 'staff',
            }, { headers: authHeaders() });
            assert.equal(duplicate.status, 302);
            assert.match(decodeURIComponent(duplicate.headers.get('location')), /already in use/);

            const createdUsername = `NewStaff${token}`;
            const created = await postForm('/admin/staff', {
                _csrf: 'staff-test-csrf-token',
                username: `  ${createdUsername}  `,
                password: 'StrongPassword!123',
                role: 'staff',
            }, { headers: authHeaders() });
            assert.equal(created.status, 302);
            const [createdRows] = await pool.execute(
                'SELECT id, username, username_normalized, password_hash FROM users WHERE username_normalized = ?',
                [createdUsername.toLowerCase()]
            );
            assert.equal(createdRows.length, 1);
            newUserIds.push(createdRows[0].id);
            assert.equal(createdRows[0].username, createdUsername);
            assert.equal(await bcrypt.compare('StrongPassword!123', createdRows[0].password_hash), true);
            assert.doesNotMatch(pageHtml, /\$2[aby]\$/);
        });

        await t.test('rejects unauthorized administrative and forged role requests, and requires CSRF', async () => {
            const forbidden = await postForm(`/admin/staff/${staffId}/role`, {
                _csrf: 'staff-test-csrf-token',
                role: 'admin',
            }, { headers: authHeaders(staffId, 0, 'staff') });
            assert.equal(forbidden.status, 403);

            const noCsrf = await postForm(`/admin/staff/${staffId}/role`, {
                role: 'admin',
            }, { headers: authHeaders() });
            assert.equal(noCsrf.status, 403);

            const publicRegister = await fetch(`${baseUrl}/register`, { redirect: 'manual' });
            assert.equal(publicRegister.status, 302);
            assert.equal(publicRegister.headers.get('location'), '/login');

            const registerAsStaff = await postForm('/register', {
                _csrf: 'staff-test-csrf-token',
                username: `register${token}`,
                password: 'RegisterPassword!2026',
                role: 'admin',
            }, { headers: authHeaders() });
            assert.equal(registerAsStaff.status, 302);
            const [registered] = await pool.execute(
                'SELECT id, role FROM users WHERE username_normalized = ?',
                [`register${token}`.toLowerCase()]
            );
            assert.equal(registered.length, 1);
            assert.equal(registered[0].role, 'staff');
            newUserIds.push(registered[0].id);
        });

        await t.test('changes own password only after current-password verification and invalidates other sessions', async () => {
            const accountPage = await fetch(`${baseUrl}/account/password`, {
                headers: authHeaders(staffId, 0, 'staff'),
            });
            assert.equal(accountPage.status, 200);
            const accountHtml = await accountPage.text();
            assert.match(accountHtml, /data-password-toggle/);
            assert.match(accountHtml, /type="password"/);

            const wrongCurrent = await postForm('/account/password', {
                _csrf: 'staff-test-csrf-token',
                current_password: 'incorrect-current',
                new_password: 'ChangedPassword!2026',
            }, { headers: authHeaders(staffId) });
            assert.equal(wrongCurrent.status, 302);
            assert.match(decodeURIComponent(wrongCurrent.headers.get('location')), /incorrect/);

            const changed = await postForm('/account/password', {
                _csrf: 'staff-test-csrf-token',
                current_password: users[2].password,
                new_password: 'ChangedPassword!2026',
            }, { headers: authHeaders(staffId) });
            assert.equal(changed.status, 302);
            assert.match(decodeURIComponent(changed.headers.get('location')), /Password\+changed/);
            const [staffRows] = await pool.execute(
                'SELECT password_hash, session_version, last_login FROM users WHERE id = ?',
                [staffId]
            );
            assert.equal(Number(staffRows[0].session_version), 1);
            assert.equal(await bcrypt.compare('ChangedPassword!2026', staffRows[0].password_hash), true);

            const staleSession = await fetch(`${baseUrl}/dashboard`, {
                redirect: 'manual',
                headers: authHeaders(staffId, 0, 'staff'),
            });
            assert.equal(staleSession.status, 302);
            assert.equal(staleSession.headers.get('location'), '/login');

            process.env.NODE_ENV = 'production';
            try {
                const forgedStaleSyncSession = await fetch(`${baseUrl}/sync`, {
                    method: 'POST',
                    headers: {
                        ...authHeaders(staffId, 0, 'staff'),
                        'Content-Type': 'application/json',
                    },
                    body: '[]',
                });
                assert.equal(forgedStaleSyncSession.status, 401);
            } finally {
                process.env.NODE_ENV = 'test';
            }
        });

        await t.test('logout is POST-only, CSRF-protected, and records a security audit event', async () => {
            const getLogout = await fetch(`${baseUrl}/logout`, { headers: authHeaders() });
            assert.equal(getLogout.status, 405);

            const missingToken = await postForm('/logout', {}, {
                headers: authHeaders(staffId, 1, 'staff'),
            });
            assert.equal(missingToken.status, 403);

            const loggedOut = await postForm('/logout', {
                _csrf: 'staff-test-csrf-token',
            }, { headers: authHeaders(staffId, 1, 'staff') });
            assert.equal(loggedOut.status, 302);
            assert.equal(loggedOut.headers.get('location'), '/login');
            const [[logoutAudit]] = await pool.execute(
                `SELECT COUNT(*) AS total FROM security_audit_log
                 WHERE actor_id = ? AND action = 'logout'`,
                [staffId]
            );
            assert.ok(Number(logoutAudit.total) >= 1);
        });

        await t.test('records last login only after successful login and denies disabled credentials', async () => {
            const [before] = await pool.execute('SELECT last_login FROM users WHERE id = ?', [staffId]);
            assert.equal(before[0].last_login, null);

            const failedLogin = await postForm('/login', {
                _csrf: 'staff-test-csrf-token',
                username: ` ${users[2].username.toUpperCase()} `,
                password: 'wrong-password',
            });
            assert.equal(failedLogin.status, 401);
            const [afterFailure] = await pool.execute('SELECT last_login FROM users WHERE id = ?', [staffId]);
            assert.equal(afterFailure[0].last_login, null);

            const successfulLogin = await postForm('/login', {
                _csrf: 'staff-test-csrf-token',
                username: ` ${users[2].username.toUpperCase()} `,
                password: 'ChangedPassword!2026',
            });
            assert.equal(successfulLogin.status, 302);
            assert.equal(successfulLogin.headers.get('location'), '/dashboard');
            const [afterSuccess] = await pool.execute('SELECT last_login FROM users WHERE id = ?', [staffId]);
            assert.ok(afterSuccess[0].last_login);
            const [[loginAudit]] = await pool.execute(
                `SELECT COUNT(*) AS total FROM security_audit_log
                 WHERE actor_id = ? AND action = 'login' AND outcome = 'success'`,
                [staffId]
            );
            assert.ok(Number(loginAudit.total) >= 1);
        });

        await t.test('resets passwords, blocks disabled accounts with existing sessions, and re-enables them', async () => {
            const reset = await postForm(`/admin/staff/${staffId}/reset-password`, {
                _csrf: 'staff-test-csrf-token',
                password: 'ResetPassword!2026',
            }, { headers: authHeaders() });
            assert.equal(reset.status, 302);
            const [afterReset] = await pool.execute(
                'SELECT password_hash, session_version FROM users WHERE id = ?',
                [staffId]
            );
            assert.equal(Number(afterReset[0].session_version), 2);
            assert.equal(await bcrypt.compare('ResetPassword!2026', afterReset[0].password_hash), true);
            assert.equal((await postForm('/login', {
                _csrf: 'staff-test-csrf-token',
                username: users[2].username,
                password: 'ChangedPassword!2026',
            })).status, 401);
            assert.equal((await postForm('/login', {
                _csrf: 'staff-test-csrf-token',
                username: users[2].username,
                password: 'ResetPassword!2026',
            })).status, 302);

            const disabled = await postForm(`/admin/staff/${staffId}/status`, {
                _csrf: 'staff-test-csrf-token',
                is_active: 'false',
            }, { headers: authHeaders() });
            assert.equal(disabled.status, 302);
            const existingSessionPage = await fetch(`${baseUrl}/dashboard`, {
                redirect: 'manual',
                headers: authHeaders(staffId, 2, 'staff'),
            });
            assert.equal(existingSessionPage.status, 302);
            assert.equal(existingSessionPage.headers.get('location'), '/login');
            const existingSessionSync = await fetch(`${baseUrl}/sync`, {
                method: 'POST',
                headers: { ...authHeaders(staffId, 2, 'staff'), 'Content-Type': 'application/json' },
                body: '[]',
            });
            assert.equal(existingSessionSync.status, 401);
            assert.equal((await postForm('/login', {
                _csrf: 'staff-test-csrf-token',
                username: users[2].username,
                password: 'ResetPassword!2026',
            })).status, 401);

            const enabled = await postForm(`/admin/staff/${staffId}/status`, {
                _csrf: 'staff-test-csrf-token',
                is_active: 'true',
            }, { headers: authHeaders() });
            assert.equal(enabled.status, 302);
            const restoredAccess = await fetch(`${baseUrl}/dashboard`, {
                redirect: 'manual',
                headers: authHeaders(staffId, 2, 'staff'),
            });
            assert.equal(restoredAccess.status, 200);
        });

        await t.test('prevents demoting the last active administrator and permits restoring disabled admins', async () => {
            const disabledFirstFixture = await postForm(`/admin/staff/${adminId}/status`, {
                _csrf: 'staff-test-csrf-token',
                is_active: 'false',
            }, { headers: controlHeaders() });
            assert.equal(disabledFirstFixture.status, 302);
            const disabledSecondFixture = await postForm(`/admin/staff/${secondAdminId}/status`, {
                _csrf: 'staff-test-csrf-token',
                is_active: 'false',
            }, { headers: controlHeaders() });
            assert.equal(disabledSecondFixture.status, 302);

            const demoteLast = await postForm(`/admin/staff/${controlAdminId}/role`, {
                _csrf: 'staff-test-csrf-token',
                role: 'staff',
            }, { headers: controlHeaders() });
            assert.equal(demoteLast.status, 302);
            assert.match(decodeURIComponent(demoteLast.headers.get('location')), /last active administrator/);
            const cannotDisableSelf = await postForm(`/admin/staff/${controlAdminId}/status`, {
                _csrf: 'staff-test-csrf-token',
                is_active: 'false',
            }, { headers: controlHeaders() });
            assert.equal(cannotDisableSelf.status, 302);
            const [adminCount] = await pool.execute(
                "SELECT COUNT(*) AS active_count FROM users WHERE role = 'admin' AND is_active = TRUE AND is_deleted = FALSE"
            );
            assert.ok(Number(adminCount[0].active_count) >= 1);

            await postForm(`/admin/staff/${adminId}/status`, {
                _csrf: 'staff-test-csrf-token',
                is_active: 'true',
            }, { headers: controlHeaders() });
            await postForm(`/admin/staff/${secondAdminId}/status`, {
                _csrf: 'staff-test-csrf-token',
                is_active: 'true',
            }, { headers: controlHeaders() });

            const firstDisable = await postForm(`/admin/staff/${secondAdminId}/status`, {
                _csrf: 'staff-test-csrf-token',
                is_active: 'false',
            }, { headers: authHeaders(adminId) });
            assert.equal(firstDisable.status, 302);
            const secondDisable = await postForm(`/admin/staff/${adminId}/status`, {
                _csrf: 'staff-test-csrf-token',
                is_active: 'false',
            }, { headers: authHeaders(secondAdminId) });
            assert.equal(secondDisable.status, 302);
            assert.match(decodeURIComponent(secondDisable.headers.get('location')), /last active administrator/);
            const [remainingAdmins] = await pool.execute(
                "SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE AND is_deleted = FALSE"
            );
            assert.ok(remainingAdmins.length >= 1);
            for (const id of [adminId, secondAdminId]) {
                await postForm(`/admin/staff/${id}/status`, {
                    _csrf: 'staff-test-csrf-token',
                    is_active: 'true',
                }, { headers: controlHeaders() });
            }
        });

        await t.test('legacy offline user-account operations are not processed by the sync endpoint', async () => {
            const [[adminSession]] = await pool.execute(
                'SELECT session_version FROM users WHERE id = ?',
                [adminId]
            );
            const response = await fetch(`${baseUrl}/sync`, {
                method: 'POST',
                headers: {
                    ...authHeaders(adminId, Number(adminSession.session_version), 'admin'),
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': 'staff-test-csrf-token',
                },
                body: JSON.stringify([{
                    type: 'EDIT',
                    table: 'users',
                    timestamp: new Date(Date.now() + 60000).toISOString(),
                    data: { id: staffId, is_active: false, role: 'admin' },
                }]),
            });
            assert.equal(response.status, 200);
            const result = await response.json();
            assert.deepEqual(result.resolvedIndexes, []);
            const [rows] = await pool.execute('SELECT role, is_active FROM users WHERE id = ?', [staffId]);
            assert.equal(rows[0].role, 'staff');
            assert.equal(Boolean(rows[0].is_active), true);

            const patientId = uuidv4();
            patientIds.push(patientId);
            await pool.execute(
                `INSERT INTO patients (id, full_name, date_of_birth, gender, phone, address)
                 VALUES (?, 'Synthetic authorization fixture', '1990-01-01', 'other', '5550001234', 'Test only')`,
                [patientId]
            );
            const deleteResponse = await fetch(`${baseUrl}/sync`, {
                method: 'POST',
                headers: {
                    ...authHeaders(staffId, 0, 'staff'),
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': 'staff-test-csrf-token',
                },
                body: JSON.stringify([{
                    operationId: uuidv4(),
                    type: 'DELETE',
                    table: 'patients',
                    timestamp: new Date().toISOString(),
                    data: { id: patientId, version: 1 },
                }]),
            });
            assert.equal(deleteResponse.status, 200);
            const deleteResult = await deleteResponse.json();
            assert.deepEqual(deleteResult.resolvedIndexes, []);
            assert.equal(deleteResult.skipped, 1);
            const [[patient]] = await pool.execute(
                'SELECT is_deleted FROM patients WHERE id = ?',
                [patientId]
            );
            assert.equal(Boolean(patient.is_deleted), false);
        });

        await t.test('login rate limit returns a generic retry response', async () => {
            let limited = false;
            for (let index = 0; index < 12; index++) {
                const response = await postForm('/login', {
                    _csrf: 'staff-test-csrf-token',
                    username: `rate-limit-${token}`,
                    password: 'synthetic-invalid-password',
                });
                if (response.status === 429) {
                    limited = true;
                    assert.match(await response.text(), /Too many sign-in attempts/);
                    break;
                }
            }
            assert.equal(limited, true);
        });
    } finally {
        if (patientIds.length) {
            await pool.execute(
                `DELETE FROM patient_activity WHERE patient_id IN (${patientIds.map(() => '?').join(',')})`,
                patientIds
            );
            await pool.execute(
                `DELETE FROM patients WHERE id IN (${patientIds.map(() => '?').join(',')})`,
                patientIds
            );
        }
        if (newUserIds.length) {
            const auditIds = [...newUserIds, adminId, secondAdminId, staffId];
            await pool.execute(
                `DELETE FROM security_audit_log
                 WHERE actor_id IN (${auditIds.map(() => '?').join(',')})
                    OR target_id IN (${auditIds.map(() => '?').join(',')})`,
                [...auditIds, ...auditIds]
            );
            await pool.execute(
                `DELETE FROM users WHERE id IN (${newUserIds.map(() => '?').join(',')})`,
                newUserIds
            );
        }
        else {
            await pool.execute(
                'DELETE FROM security_audit_log WHERE actor_id IN (?, ?, ?) OR target_id IN (?, ?, ?)',
                [adminId, secondAdminId, staffId, adminId, secondAdminId, staffId]
            );
        }
        await pool.execute(
            `DELETE FROM users WHERE id IN (?, ?, ?)`,
            [adminId, secondAdminId, staffId]
        );
        if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        if (previousTestAuthBypass === undefined)
            delete process.env.HEALTHSYS_TEST_AUTH_BYPASS;
        else process.env.HEALTHSYS_TEST_AUTH_BYPASS = previousTestAuthBypass;
        await pool.end();
    }
});
