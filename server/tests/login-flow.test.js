const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const express = require('express');
const session = require('express-session');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

test('successful login saves the regenerated session before redirecting', async (t) => {
  const password = 'SyntheticLogin!2026';
  const user = {
    id: randomUUID(),
    username: 'synthetic-admin',
    password_hash: await bcrypt.hash(password, 4),
    role: 'admin',
    is_active: true,
    is_deleted: false,
    session_version: 0,
  };
  const calls = [];
  const pool = {
    async execute(sql, values = []) {
      calls.push(sql);
      if (sql.includes('FROM users WHERE username_normalized = ?')) {
        return [values[0] === user.username ? [{ ...user }] : []];
      }
      if (sql.includes('FROM users WHERE id = ?')) {
        return [
          [
            {
              id: user.id,
              username: user.username,
              role: user.role,
              is_active: user.is_active,
              is_deleted: user.is_deleted,
              session_version: user.session_version,
            },
          ],
        ];
      }
      if (sql.includes('UPDATE users SET last_login')) {
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('INSERT INTO security_audit_log')) {
        return [{ affectedRows: 1 }];
      }
      throw new Error('Unexpected query in login flow test.');
    },
  };
  const dbPath = require.resolve('../db');
  const loginPath = require.resolve('../routes/login');
  const originalDb = require.cache[dbPath];
  const originalLogin = require.cache[loginPath];
  require.cache[dbPath] = new Module(dbPath);
  require.cache[dbPath].exports = pool;
  require.cache[dbPath].loaded = true;
  delete require.cache[loginPath];
  const loginRouter = require('../routes/login');
  if (originalDb) require.cache[dbPath] = originalDb;
  else delete require.cache[dbPath];
  if (originalLogin) require.cache[loginPath] = originalLogin;
  else delete require.cache[loginPath];

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(
    session({
      secret: 'synthetic-login-test-session-secret',
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.use('/', loginRouter);
  app.get('/dashboard', (req, res) => {
    res.json({ user: req.session.user || null });
  });

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const loginPage = await fetch(`${baseUrl}/login`);
  assert.equal(loginPage.status, 200);
  const html = await loginPage.text();
  const csrfToken = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  const initialCookie = loginPage.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(csrfToken);
  assert.ok(initialCookie);

  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: initialCookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      _csrf: csrfToken,
      username: user.username,
      password,
    }),
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/dashboard');
  const authenticatedCookie = response.headers
    .get('set-cookie')
    ?.split(';', 1)[0];
  assert.ok(authenticatedCookie);

  const dashboard = await fetch(`${baseUrl}/dashboard`, {
    headers: { Cookie: authenticatedCookie },
  });
  assert.deepEqual(await dashboard.json(), {
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      authVersion: 0,
    },
  });
  const sessionStatus = await fetch(`${baseUrl}/session/status`, {
    headers: { Cookie: authenticatedCookie, Accept: 'application/json' },
  });
  assert.equal(sessionStatus.status, 200);
  assert.equal(sessionStatus.headers.get('cache-control'), 'no-store');
  const sessionStatusBody = await sessionStatus.json();
  assert.equal(sessionStatusBody.authenticated, true);
  assert.equal(sessionStatusBody.user.id, user.id);
  assert.equal(sessionStatusBody.user.username, user.username);
  assert.equal(sessionStatusBody.user.role, user.role);
  assert.equal(typeof sessionStatusBody.csrfToken, 'string');
  assert.equal(
    calls.filter((sql) => sql.includes('UPDATE users SET last_login')).length,
    1,
  );
});
