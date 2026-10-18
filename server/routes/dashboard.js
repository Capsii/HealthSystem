const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const patientRepository = require('../patient_repository');
const logger = require('../logger');

router.use(requireAuth);

const DASHBOARD_ACTIVITY_ACTIONS = [
    'patient.create',
    'patient.update',
    'patient.delete',
    'patient.restore',
    'patient.visit.create',
    'patient.import.csv',
    'patient.export.csv',
    'patient.sync',
    'patient.sync.conflict',
    'staff.create',
    'staff.enable',
    'staff.disable',
    'staff.role_change',
    'staff.password_reset',
    'backup.server.create',
    'backup.server.restore',
];

async function getRecentActivity(user) {
    const actions = user.role === 'admin'
        ? DASHBOARD_ACTIVITY_ACTIONS
        : DASHBOARD_ACTIVITY_ACTIONS.filter((action) =>
            action.startsWith('patient.') || action.startsWith('sync.')
        );
    const placeholders = actions.map(() => '?').join(', ');
    const [rows] = await pool.execute(
        `SELECT a.action, a.outcome, a.created_at, a.actor_role, u.username AS actor_name
         FROM security_audit_log a
         LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.action IN (${placeholders})
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 8`,
        actions,
    );
    return rows.map((row) => ({
        ...row,
        actor_role: ['admin', 'staff'].includes(row.actor_role) ? row.actor_role : null,
    }));
}

async function getMetrics(user) {
    const patientCounts = await patientRepository.getCounts(pool);
    let staffCounts = null;
    if (user.role === 'admin') {
        const [[counts]] = await pool.execute(`
            SELECT COUNT(*) AS total,
                   COALESCE(SUM(is_active = 1), 0) AS active,
                   COALESCE(SUM(is_active <> 1 OR is_active IS NULL), 0) AS inactive
            FROM users
            WHERE is_deleted = FALSE
        `);
        staffCounts = {
            total: Number(counts.total),
            active: Number(counts.active),
            inactive: Number(counts.inactive),
        };
    }

    let lastSuccessfulSyncAt = null;
    let lastSyncAttemptAt = null;
    let lastAttemptOutcome = null;
    try {
        const [[syncTimes]] = await pool.execute(`
            SELECT MAX(CASE WHEN success = TRUE THEN synced_at END) AS last_successful_sync_at,
                   MAX(synced_at) AS last_sync_attempt_at
            FROM sync_logs
            WHERE user_id = ?
        `, [user.id]);
        lastSuccessfulSyncAt = syncTimes.last_successful_sync_at;
        lastSyncAttemptAt = syncTimes.last_sync_attempt_at;
        if (lastSyncAttemptAt) {
            const [attemptRows] = await pool.execute(`
                SELECT success, conflict_detected
                FROM sync_logs
                WHERE user_id = ? AND synced_at = ?
                ORDER BY success ASC
                LIMIT 1
            `, [user.id, lastSyncAttemptAt]);
            if (attemptRows.length) {
                lastAttemptOutcome = attemptRows[0].success === 1 || attemptRows[0].success === true
                    ? 'Success'
                    : attemptRows[0].conflict_detected
                        ? 'Partial Failure'
                        : attemptRows[0].success === 0 || attemptRows[0].success === false
                            ? 'Failure'
                            : 'Unknown';
            }
        }
    } catch (err) {
        logger.error('dashboard.sync_summary.failed', {
            errorCode: err.code || 'DATABASE_ERROR',
        });
    }

    let recentPatients = null;
    let recentActivity = null;
    try {
        const [rows] = await pool.execute(
            `SELECT id, full_name, created_at, is_deleted
             FROM patients
             WHERE is_deleted = FALSE
             ORDER BY created_at DESC, id DESC
             LIMIT 5`,
        );
        recentPatients = rows;
        recentActivity = await getRecentActivity(user);
    } catch (err) {
        logger.error('dashboard.recent_activity.failed', {
            errorCode: err.code || 'DATABASE_ERROR',
        });
    }

    return {
        serverSnapshotAt: new Date().toISOString(),
        patients: {
            ...patientCounts,
        },
        staff: staffCounts,
        lastSuccessfulSyncAt,
        lastSyncAttemptAt,
        lastAttemptOutcome,
        recentPatients,
        recentActivity,
    };
}

router.get('/metrics', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        res.json(await getMetrics(req.session.user));
    } catch (err) {
        logger.error('dashboard.metrics.failed', {
            requestId: req.requestId,
            errorCode: err.code || 'DATABASE_ERROR',
        });
        res.status(500).json({ error: 'Dashboard metrics are unavailable.' });
    }
});

router.get('/', async (req, res) => {
    try {
        const metrics = await getMetrics(req.session.user);
        res.set('Cache-Control', 'no-store');
        res.render('dashboard', {
            user: req.session.user,
            metrics,
            metricsError: null,
        });
    } catch (err) {
        logger.error('dashboard.render.failed', {
            requestId: req.requestId,
            errorCode: err.code || 'DATABASE_ERROR',
        });
        res.status(500).render('dashboard', {
            user: req.session.user,
            metrics: null,
            metricsError: 'Dashboard metrics could not be loaded. Try refreshing when the server is available.',
        });
    }
});


module.exports = router;