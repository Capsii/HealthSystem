const express = require('express');
const router = express.Router();
const pool = require('../db');
const bcrypt = require('bcrypt');
const { normalizeUsername } = require('../staff_security');
const {
    csrfToken,
    requireAuth,
    sensitiveCsrf,
    recordAudit,
} = require('../middleware/auth');
const { createRateLimiter } = require('../rate_limit');

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many sign-in attempts. Wait before trying again.',
});

// GET login page
router.get('/login', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.render('login', { error: null, csrfToken: csrfToken(req) });
});

router.get('/session/status', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({
    authenticated: true,
    user: {
      id: String(req.session.user.id),
      username: req.session.user.username,
      role: req.session.user.role,
    },
    csrfToken: req.session.csrfToken,
  });
});

// POST login
router.post('/login', loginLimiter, sensitiveCsrf, async (req, res) => {
  const body = req.body || {};
  const username = normalizeUsername(body.username).toLowerCase();
  const { password } = body;
  const loginFailure = () => {
    void recordAudit({
      action: 'login',
      outcome: 'failure',
      requestId: req.id || null,
    });
    return res.status(401).render('login', {
      error: 'Invalid username or password',
      csrfToken: csrfToken(req),
    });
  };

  try {
    const [rows] = await pool.execute(
      `SELECT id, username, password_hash, role, is_active, is_deleted, session_version
             FROM users WHERE username_normalized = ?`,
      [username],
    );

    if (rows.length === 0) {
      return loginFailure();
    }

    const user = rows[0];
    const passwordMatch =
      typeof password === 'string' &&
      (await bcrypt.compare(password, user.password_hash));

    if (!passwordMatch || !user.is_active || user.is_deleted) {
      return loginFailure();
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate((error) => (error ? reject(error) : resolve()));
    });
    const [result] = await pool.execute(
      `UPDATE users SET last_login = UTC_TIMESTAMP()
             WHERE id = ? AND is_active = TRUE AND is_deleted = FALSE`,
      [user.id],
    );
    if (!result.affectedRows) {
      return loginFailure();
    }
    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      authVersion: Number(user.session_version),
    };
    await new Promise((resolve, reject) => {
      req.session.save((error) => (error ? reject(error) : resolve()));
    });
    await recordAudit({
      actorId: user.id,
      action: 'login',
      targetId: user.id,
      requestId: req.id || null,
    });
    return res.redirect('/dashboard');
  } catch (err) {
    console.error('Login unavailable:', err.code || 'AUTHENTICATION_ERROR');
    return res.status(503).render('login', {
      error: 'Sign in is temporarily unavailable. Please try again.',
      csrfToken: csrfToken(req),
    });
  }
});

// GET logout
router.get('/logout', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.status(405).send('Use the sign-out form to end your session.');
});

router.post('/logout', sensitiveCsrf, (req, res) => {
  const actorId = req.session?.user?.id || null;
  if (!req.session) {
    res.clearCookie('connect.sid', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
    return res.redirect('/login');
  }
  req.session.destroy(async (err) => {
    if (err) {
      console.error('Logout failed:', err.code || 'SESSION_ERROR');
      return res.status(500).send('Unable to log out. Please try again.');
    }

    res.clearCookie('connect.sid', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
    await recordAudit({
      actorId,
      action: 'logout',
      targetId: actorId,
      requestId: req.id || null,
    });
    return res.redirect('/login');
  });
});

module.exports = router;
