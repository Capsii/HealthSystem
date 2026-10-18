const express = require('express');
const router = express.Router();
const pool = require('../db');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { requireRole, sensitiveCsrf, csrfToken, recordAudit } = require('../middleware/auth');
const { validateUsername, validatePassword } = require('../staff_security');
const { resolveReportRange } = require('../report_filters');
const { csvRow, formatCsvTimestamp } = require('../patient_csv');
const patientRepository = require('../patient_repository');
const { writeAuditEvent } = require('../audit');

router.use(requireRole('admin'));
router.use(sensitiveCsrf);

function staffRedirect(res, key, message) {
    return res.redirect(`/admin/staff?${key}=${encodeURIComponent(message)}`);
}

let adminMutationQueue = Promise.resolve();

async function withAdminMutationLock(callback) {
    const previous = adminMutationQueue;
    let release;
    adminMutationQueue = new Promise((resolve) => {
        release = resolve;
    });

    await previous;
    try {
        return await callback();
    } finally {
        release();
    }
}

router.get('/staff', async (req, res) => {
    try {
        const [users] = await pool.query(
            `SELECT id, username, role, is_active, last_login, created_at, created_by
             FROM users WHERE is_deleted = FALSE ORDER BY created_at DESC`
        );
        res.set('Cache-Control', 'no-store');
        res.render('admin/staff', {
            users,
            user: req.session.user,
            csrfToken: csrfToken(req),
            error: typeof req.query.error === 'string' ? req.query.error : null,
            success: typeof req.query.success === 'string' ? req.query.success : null
        });
    } catch (err) {
        console.error('Error fetching staff:', err.code || err.message);
        res.status(500).send('Could not load staff accounts. Please try again.');
    }
});

router.post('/staff', async (req, res) => {
    const { username, password, role } = req.body || {};
    const validatedUsername = validateUsername(username);
    const passwordError = validatePassword(password);
    if (validatedUsername.error) return staffRedirect(res, 'error', validatedUsername.error);
    if (passwordError) return staffRedirect(res, 'error', passwordError);
    if (!['admin', 'staff'].includes(role)) {
        return staffRedirect(res, 'error', 'Choose a valid account role.');
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [existing] = await connection.execute(
            'SELECT id FROM users WHERE username_normalized = ?',
            [validatedUsername.normalized]
        );
        if (existing.length > 0) {
            await connection.rollback();
            return staffRedirect(res, 'error', 'That username is already in use.');
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const id = crypto.randomUUID();
        const creatorId = req.session.user.id;

        await connection.execute(
            `INSERT INTO users
             (id, username, username_normalized, password_hash, role, is_active, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, TRUE, ?, NOW())`,
            [id, validatedUsername.username, validatedUsername.normalized, hashedPassword, role, creatorId]
        );
        await writeAuditEvent(connection, {
            actorId: creatorId,
            actorRole: req.session.user.role,
            action: 'staff.create',
            targetId: id,
            entityType: 'user',
            entityId: id,
            requestId: req.requestId || null,
        });
        await connection.commit();

        return staffRedirect(res, 'success', 'Staff account created.');
    } catch (err) {
        if (connection) await connection.rollback();
        if (err.code === 'ER_DUP_ENTRY') {
            return staffRedirect(res, 'error', 'That username is already in use.');
        }
        console.error('Error adding staff account:', err.code || err.message);
        return staffRedirect(res, 'error', 'Could not create the account. Please try again.');
    } finally {
        if (connection) connection.release();
    }
});

router.post('/staff/:id/status', async (req, res) => {
    const { id } = req.params;
    const requestedStatus = req.body?.is_active;
    const active = requestedStatus === 'true';
    if (!['true', 'false'].includes(requestedStatus)) {
        return staffRedirect(res, 'error', 'Choose a valid account status.');
    }
    if (active === false && id === String(req.session.user.id)) {
        return staffRedirect(res, 'error', 'You cannot disable your own account.');
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const redirectResponse = await withAdminMutationLock(async () => {
            await connection.execute(
                "SELECT id FROM users WHERE role = 'admin' ORDER BY id FOR UPDATE"
            );
            const [targets] = await connection.execute(
                'SELECT id, role, is_active FROM users WHERE id = ? AND is_deleted = FALSE FOR UPDATE',
                [id]
            );
            const target = targets[0];
            if (!target) {
                await connection.rollback();
                return staffRedirect(res, 'error', 'The selected account was not found.');
            }

            const removingActiveAdmin = target.role === 'admin' && active === false;
            if (removingActiveAdmin) {
                const [counts] = await connection.execute(
                    "SELECT COUNT(*) AS active_admins FROM users WHERE role = 'admin' AND is_active = TRUE AND is_deleted = FALSE"
                );
                if (Number(counts[0].active_admins) <= 1) {
                    await connection.rollback();
                    return staffRedirect(res, 'error', 'The last active administrator cannot be disabled.');
                }
            }

            await connection.execute(
                'UPDATE users SET is_active = ? WHERE id = ?',
                [active, id]
            );
            await writeAuditEvent(connection, {
                actorId: req.session.user.id,
                actorRole: req.session.user.role,
                action: active ? 'staff.enable' : 'staff.disable',
                targetId: id,
                entityType: 'user',
                entityId: id,
                requestId: req.requestId || null,
            });
            await connection.commit();
            return staffRedirect(res, 'success', active ? 'Account enabled.' : 'Account disabled.');
        });
        return redirectResponse;
    } catch (err) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Could not roll back staff status transaction:', rollbackError.code || rollbackError.message);
            }
        }
        console.error('Could not update staff account status:', err.code || err.message);
        return staffRedirect(res, 'error', 'Could not update account status. Please try again.');
    } finally {
        if (connection) connection.release();
    }
});

router.post('/staff/:id/role', async (req, res) => {
    const { id } = req.params;
    const { role } = req.body || {};
    if (!['admin', 'staff'].includes(role)) {
        return staffRedirect(res, 'error', 'Choose a valid account role.');
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const redirectResponse = await withAdminMutationLock(async () => {
            await connection.execute(
                "SELECT id FROM users WHERE role = 'admin' ORDER BY id FOR UPDATE"
            );
            const [targets] = await connection.execute(
                'SELECT id, role, is_active FROM users WHERE id = ? AND is_deleted = FALSE FOR UPDATE',
                [id]
            );
            const target = targets[0];
            if (!target) {
                await connection.rollback();
                return staffRedirect(res, 'error', 'The selected account was not found.');
            }

            if (target.role === 'admin' && role !== 'admin') {
                const [counts] = await connection.execute(
                    "SELECT COUNT(*) AS active_admins FROM users WHERE role = 'admin' AND is_active = TRUE AND is_deleted = FALSE"
                );
                if (Number(counts[0].active_admins) <= 1) {
                    await connection.rollback();
                    return staffRedirect(res, 'error', 'The last active administrator cannot be demoted.');
                }
            }

            await connection.execute(
                'UPDATE users SET role = ?, session_version = session_version + 1 WHERE id = ?',
                [role, id]
            );
            await writeAuditEvent(connection, {
                actorId: req.session.user.id,
                actorRole: req.session.user.role,
                action: 'staff.role_change',
                targetId: id,
                entityType: 'user',
                entityId: id,
                requestId: req.requestId || null,
            });
            await connection.commit();
            return staffRedirect(res, 'success', 'Account role updated.');
        });
        return redirectResponse;
    } catch (err) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Could not roll back staff role transaction:', rollbackError.code || rollbackError.message);
            }
        }
        console.error('Could not update staff role:', err.code || err.message);
        return staffRedirect(res, 'error', 'Could not update account role. Please try again.');
    } finally {
        if (connection) connection.release();
    }
});

router.post('/staff/:id/reset-password', async (req, res) => {
    const { id } = req.params;
    const { password } = req.body || {};
    const passwordError = validatePassword(password);
    if (passwordError) return staffRedirect(res, 'error', passwordError);

    let connection;
    try {
        const hash = await bcrypt.hash(password, 10);
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [result] = await connection.execute(
            'UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ? AND is_deleted = FALSE',
            [hash, id]
        );
        if (!result.affectedRows) {
            await connection.rollback();
            return staffRedirect(res, 'error', 'The selected account was not found.');
        }
        await writeAuditEvent(connection, {
            actorId: req.session.user.id,
            actorRole: req.session.user.role,
            action: 'staff.password_reset',
            targetId: id,
            entityType: 'user',
            entityId: id,
            requestId: req.requestId || null,
        });
        await connection.commit();
        return staffRedirect(res, 'success', 'Password reset. The account must sign in again.');
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Could not reset staff password:', err.code || err.message);
        return staffRedirect(res, 'error', 'Could not reset the password. Please try again.');
    } finally {
        if (connection) connection.release();
    }
});


// --- Reports ---

function renderReportError(res, user, range, error, status = 400) {
    res.set('Cache-Control', 'no-store');
    return res.status(status).render('admin/reports', {
        user,
        reportError: error,
        reportGeneratedAt: null,
        dateRange: range,
        dateRangeLabel: range.label || 'Invalid range',
        dateRangeOptions: ['today', '7d', '30d', 'custom', 'all'],
        totalPatients: null,
        deletedPatients: null,
        newPatientsInRange: null,
        patientsByMonth: [],
        genderBreakdown: [],
        activeStaff: null,
        disabledStaff: null,
        deletedStaff: null,
        staffBreakdown: [],
        totalSyncOps: null,
        syncEvents: null,
        successfulSyncEvents: null,
        failedSyncEvents: null,
        partialSyncEvents: null,
        unknownSyncEvents: null,
        syncConflicts: null,
        lastSuccessfulSyncAt: null,
        lastSyncAttemptAt: null,
        syncStatsAvailable: false
    });
}

router.get('/reports', async (req, res) => {
    const dateRange = resolveReportRange(req.query);
    if (dateRange.error) {
        return renderReportError(res, req.session.user, dateRange, dateRange.error);
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const cohortConditions = ['is_deleted = FALSE'];
        const cohortParams = [];
        const syncConditions = [];
        const syncParams = [];
        if (dateRange.fromDate) {
            cohortConditions.push('created_at >= ?');
            cohortParams.push(`${dateRange.fromDate} 00:00:00`);
            syncConditions.push('synced_at >= ?');
            syncParams.push(`${dateRange.fromDate} 00:00:00`);
        }
        if (dateRange.toDateExclusive) {
            cohortConditions.push('created_at < ?');
            cohortParams.push(`${dateRange.toDateExclusive} 00:00:00`);
            syncConditions.push('synced_at < ?');
            syncParams.push(`${dateRange.toDateExclusive} 00:00:00`);
        }
        const patientWhere = `WHERE ${cohortConditions.join(' AND ')}`;
        const syncWhere = syncConditions.length ? `WHERE ${syncConditions.join(' AND ')}` : '';

        const patientStatus = await patientRepository.getStatusCounts(connection);
        const [[patientCohort]] = await connection.execute(
            `SELECT COUNT(*) AS total FROM patients ${patientWhere}`,
            cohortParams
        );
        const [trendRows] = await connection.execute(
            `SELECT DATE_FORMAT(created_at, '${dateRange.bucketFormat}') AS bucket, COUNT(*) AS count
             FROM patients ${patientWhere}
             GROUP BY bucket ORDER BY bucket ASC`,
            cohortParams
        );
        const [genderRows] = await connection.execute(`
            SELECT
                CASE
                    WHEN gender IS NULL OR TRIM(gender) = '' THEN 'Unspecified'
                    ELSE CONCAT(UPPER(LEFT(TRIM(gender), 1)), LOWER(SUBSTRING(TRIM(gender), 2)))
                END AS label,
                COUNT(*) AS count
            FROM patients ${patientWhere}
            GROUP BY label
            ORDER BY count DESC, label ASC
        `, cohortParams);

        const [[staffStatus]] = await connection.execute(`
            SELECT COALESCE(SUM(is_deleted = FALSE), 0) AS total,
                   COALESCE(SUM(is_deleted = FALSE AND is_active = TRUE), 0) AS active,
                   COALESCE(SUM(is_deleted = FALSE AND (is_active = FALSE OR is_active IS NULL)), 0) AS disabled,
                   COALESCE(SUM(is_deleted = TRUE), 0) AS deleted
            FROM users
        `);
        const [staffRows] = await connection.execute(`
            SELECT role, COUNT(*) AS count
            FROM users
            WHERE is_deleted = FALSE AND is_active = TRUE
            GROUP BY role
            ORDER BY role ASC
        `);
        const [[syncStats]] = await connection.execute(`
            SELECT COUNT(*) AS events,
                   COALESCE(SUM(operation_count), 0) AS operations,
                   COALESCE(SUM(success = TRUE), 0) AS successful,
                   COALESCE(SUM(success = FALSE AND conflict_detected = TRUE), 0) AS partial,
                   COALESCE(SUM(success = FALSE AND COALESCE(conflict_detected, FALSE) = FALSE), 0) AS failed,
                   COALESCE(SUM(success IS NULL), 0) AS unknown,
                   COALESCE(SUM(conflict_detected = TRUE), 0) AS conflicts,
                   MAX(CASE WHEN success = TRUE THEN synced_at END) AS last_successful_sync_at,
                   MAX(synced_at) AS last_sync_attempt_at
            FROM sync_logs ${syncWhere}
        `, syncParams);
        await connection.commit();

        const trend = trendRows.map((row) => {
            const bucket = row.bucket;
            const parsed = bucket.length === 7
                ? new Date(`${bucket}-01T00:00:00Z`)
                : new Date(`${bucket}T00:00:00Z`);
            const label = bucket.length === 7
                ? parsed.toLocaleString('en', { month: 'short', timeZone: 'UTC' })
                : parsed.toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
            return { bucket, label, count: Number(row.count) };
        });
        const maximum = Math.max(1, ...trend.map((item) => item.count));
        trend.forEach((item) => {
            item.height = Math.round((item.count / maximum) * 100);
        });
        const activePatients = Number(patientStatus.active);
        const genderBreakdown = genderRows.map((row) => ({
            label: row.label,
            count: Number(row.count),
            percentage: Number(patientCohort.total)
                ? Math.round((Number(row.count) / Number(patientCohort.total)) * 100)
                : 0
        }));

        res.set('Cache-Control', 'no-store');
        return res.render('admin/reports', {
            user: req.session.user,
            reportError: null,
            reportGeneratedAt: new Date().toISOString(),
            dateRange,
            dateRangeLabel: dateRange.label,
            dateRangeOptions: ['today', '7d', '30d', 'custom', 'all'],
            totalPatients: activePatients,
            deletedPatients: Number(patientStatus.deleted),
            unknownPatientStatus: Number(patientStatus.unknown_status),
            newPatientsInRange: Number(patientCohort.total),
            patientsByMonth: trend,
            genderBreakdown,
            activeStaff: Number(staffStatus.active),
            disabledStaff: Number(staffStatus.disabled),
            deletedStaff: Number(staffStatus.deleted),
            staffBreakdown: staffRows.map((row) => ({
                role: row.role,
                count: Number(row.count)
            })),
            totalSyncOps: Number(syncStats.operations),
            syncEvents: Number(syncStats.events),
            successfulSyncEvents: Number(syncStats.successful),
            failedSyncEvents: Number(syncStats.failed),
            partialSyncEvents: Number(syncStats.partial),
            unknownSyncEvents: Number(syncStats.unknown),
            syncConflicts: Number(syncStats.conflicts),
            lastSuccessfulSyncAt: syncStats.last_successful_sync_at,
            lastSyncAttemptAt: syncStats.last_sync_attempt_at,
            syncStatsAvailable: true
        });
    } catch (err) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Could not roll back report snapshot:', rollbackError.code || rollbackError.message);
            }
        }
        console.error('Reports query failed:', err.code || err.message);
        return renderReportError(
            res,
            req.session.user,
            dateRange,
            'Reports could not be loaded from the database. No totals are shown; try again when the server is available.',
            500
        );
    } finally {
        if (connection) connection.release();
    }
});

router.get('/reports/registrations.csv', async (req, res) => {
    const dateRange = resolveReportRange(req.query);
    if (dateRange.error) return res.status(400).send(dateRange.error);

    const conditions = ['is_deleted = FALSE'];
    const params = [];
    if (dateRange.fromDate) {
        conditions.push('created_at >= ?');
        params.push(`${dateRange.fromDate} 00:00:00`);
    }
    if (dateRange.toDateExclusive) {
        conditions.push('created_at < ?');
        params.push(`${dateRange.toDateExclusive} 00:00:00`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const pageSize = 500;
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [[countRow]] = await connection.execute(
            `SELECT COUNT(*) AS total FROM patients ${where}`,
            params,
        );
        const count = Number(countRow.total);
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, private',
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="healthsys-registrations-${dateRange.range}.csv"`,
            'X-Content-Type-Options': 'nosniff',
            'X-Exported-Records': String(count),
        });
        const write = async (chunk) => {
            if (res.write(chunk)) return;
            await new Promise((resolve, reject) => {
                const cleanup = () => {
                    res.removeListener('drain', onDrain);
                    res.removeListener('error', onError);
                    res.removeListener('close', onClose);
                };
                const onDrain = () => {
                    cleanup();
                    resolve();
                };
                const onError = (error) => {
                    cleanup();
                    reject(error);
                };
                const onClose = () => {
                    cleanup();
                    reject(new Error('Report download was interrupted.'));
                };
                res.once('drain', onDrain);
                res.once('error', onError);
                res.once('close', onClose);
            });
        };
        await write(`\uFEFF${csvRow(['Patient ID', 'Name', 'Gender', 'Registered at (UTC)'])}\r\n`);
        let offset = 0;
        while (offset < count) {
            const [rows] = await connection.query(
                `SELECT id, full_name, gender, created_at
                 FROM patients ${where}
                 ORDER BY created_at ASC, id ASC
                 LIMIT ? OFFSET ?`,
                [...params, pageSize, offset],
            );
            if (!rows.length) break;
            for (const row of rows) {
                await write(`${csvRow([
                    row.id,
                    row.full_name,
                    row.gender,
                    formatCsvTimestamp(row.created_at),
                ])}\r\n`);
            }
            offset += rows.length;
        }
        await writeAuditEvent(connection, {
            actorId: req.session.user.id,
            actorRole: req.session.user.role,
            action: 'report.registration.export',
            entityType: 'report',
            outcome: 'success',
            requestId: req.requestId || null,
            details: {
                range: dateRange.range,
                fromDate: dateRange.fromDate,
                toDate: dateRange.toDate,
                exportedCount: count,
            },
        });
        await connection.commit();
        connection.release();
        connection = null;
        return res.end();
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Could not roll back registration report export:', rollbackError.code || 'DATABASE_ERROR');
            }
            connection.release();
            connection = null;
        }
        await recordAudit({
            actorId: req.session.user.id,
            actorRole: req.session.user.role,
            action: 'report.registration.export',
            entityType: 'report',
            outcome: 'failure',
            requestId: req.requestId || null,
        });
        console.error('Registration report export failed:', error.code || 'EXPORT_ERROR');
        if (!res.headersSent) return res.status(500).send('The registration report could not be exported.');
        return res.destroy();
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;
