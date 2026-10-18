const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { requireAuth, sensitiveCsrf, csrfToken } = require('../middleware/auth');
const { writeAuditEvent } = require('../audit');
const { validatePassword } = require('../staff_security');

const router = express.Router();
router.use(requireAuth);
router.use(sensitiveCsrf);

router.get('/password', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.render('account-password', {
        user: req.session.user,
        csrfToken: csrfToken(req),
        error: typeof req.query.error === 'string' ? req.query.error : null,
        success: typeof req.query.success === 'string' ? req.query.success : null
    });
});

router.post('/password', async (req, res) => {
    const { current_password: currentPassword, new_password: newPassword } = req.body || {};
    const passwordError = validatePassword(newPassword);
    if (!currentPassword || passwordError) {
        return res.redirect(`/account/password?error=${encodeURIComponent(passwordError || 'Enter your current password.')}`);
    }

    let connection;
    let transactionOpen = false;
    let passwordChanged = false;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        transactionOpen = true;
        const [rows] = await connection.execute(
            'SELECT password_hash, session_version FROM users WHERE id = ? AND is_active = TRUE AND is_deleted = FALSE FOR UPDATE',
            [req.session.user.id],
        );
        if (!rows.length || !await bcrypt.compare(currentPassword, rows[0].password_hash)) {
            await connection.rollback();
            transactionOpen = false;
            return res.redirect('/account/password?error=Current+password+is+incorrect.');
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);
        const [result] = await connection.execute(
            `UPDATE users
             SET password_hash = ?, session_version = session_version + 1
             WHERE id = ? AND session_version = ? AND is_active = TRUE AND is_deleted = FALSE`,
            [passwordHash, req.session.user.id, rows[0].session_version],
        );
        if (!result.affectedRows) {
            await connection.rollback();
            transactionOpen = false;
            return res.redirect('/account/password?error=Your+account+changed.+Sign+in+again.');
        }
        await writeAuditEvent(connection, {
            actorId: req.session.user.id,
            actorRole: req.session.user.role,
            action: 'account.password_change',
            targetId: req.session.user.id,
            entityType: 'user',
            entityId: req.session.user.id,
            requestId: req.requestId || null,
        });
        await connection.commit();
        transactionOpen = false;
        passwordChanged = true;

        const updatedUser = {
            ...req.session.user,
            authVersion: Number(rows[0].session_version) + 1
        };
        await new Promise((resolve, reject) => {
            req.session.regenerate((error) => error ? reject(error) : resolve());
        });
        req.session.user = updatedUser;
        req.session.csrfToken = csrfToken(req);
        return res.redirect('/account/password?success=Password+changed.+Other+sessions+were+signed+out.');
    } catch (error) {
        if (connection && transactionOpen) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Could not roll back password change:', rollbackError.code || 'DATABASE_ERROR');
            }
        }
        console.error('Password change failed:', error.code || 'PASSWORD_CHANGE_ERROR');
        if (passwordChanged) {
            return res.status(500).send('Password changed, but the session could not be refreshed. Please sign in again.');
        }
        return res.redirect('/account/password?error=Could+not+change+the+password.+Please+try+again.');
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;
