const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const test = require('node:test');

const viewsDirectory = path.join(__dirname, '..', 'views');
const sidebarPath = path.join(viewsDirectory, 'partials', 'sidebar.ejs');
const pages = [
  {
    name: 'Dashboard',
    file: 'dashboard.ejs',
    include: 'partials/sidebar',
    active: 'dashboard',
  },
  {
    name: 'Patients',
    file: 'patients.ejs',
    include: 'partials/sidebar',
    active: 'patients',
  },
  {
    name: 'Patient profile',
    file: 'patient-profile.ejs',
    include: 'partials/sidebar',
    active: 'patients',
  },
  {
    name: 'Staff',
    file: path.join('admin', 'staff.ejs'),
    include: '../partials/sidebar',
    active: 'staff',
  },
  {
    name: 'Reports',
    file: path.join('admin', 'reports.ejs'),
    include: '../partials/sidebar',
    active: 'reports',
  },
  {
    name: 'Data Recovery',
    file: path.join('admin', 'data-recovery.ejs'),
    include: '../partials/sidebar',
    active: 'recovery',
  },
];
const adminLinks = [
  ['/dashboard', 'Dashboard'],
  ['/patients', 'Patients'],
  ['/admin/staff', 'Staff'],
  ['/admin/reports', 'Reports'],
  ['/admin/recovery', 'Data recovery'],
  ['/account/password', 'Change Password'],
];

test('all authorized pages use the shared sidebar and load its icon font', () => {
  for (const page of pages) {
    const source = fs.readFileSync(
      path.join(viewsDirectory, page.file),
      'utf8',
    );
    assert.match(
      source,
      new RegExp(
        `<%-\\s*include\\(['"]${page.include.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"],\\s*\\{\\s*activePage:\\s*['"]${page.active}['"]\\s*\\}\\)\\s*%>`,
      ),
      `${page.name} must include the shared sidebar with its active page`,
    );
    assert.match(
      source,
      /cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome\/6\.0\.0\/css\/all\.min\.css/,
      `${page.name} must load Font Awesome for sidebar icons`,
    );
    assert.match(
      source,
      /<script src="\/js\/ui\.js" defer><\/script>/,
      `${page.name} must load the shared navigation controls`,
    );
    assert.match(
      source,
      /<script src="\/js\/offline-access\.js"><\/script>/,
      `${page.name} must establish its account context from authenticated server markup`,
    );
    assert.match(
      source,
      /class="dashboard-container"/,
      `${page.name} must use the shared responsive layout`,
    );
    assert.match(
      source,
      /href="\/ui-modernization\.css"/,
      `${page.name} must load the shared UI system`,
    );
  }
});

test('shared sidebar styles support collapse, mobile navigation, and scrolling', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'style.css'),
    'utf8',
  );

  assert.match(css, /@media\s*\(max-width:\s*700px\)/);
  assert.match(css, /\.sidebar-collapsed\s+\.sidebar\s*\{/);
  assert.match(css, /\.mobile-nav-open\s+\.sidebar\s*\{/);
  assert.match(
    css,
    /\.sidebar,\s*\.sidebar-collapsed\s+\.sidebar\s*\{[\s\S]*?overflow-y:\s*auto;/,
  );
  assert.match(css, /\.sidebar\s*\{[^}]*flex:\s*0\s+0\s+250px;[^}]*\}/);
  assert.match(
    css,
    /\.nav-item\s*\{[^}]*font-size:\s*0\.95rem;[^}]*white-space:\s*nowrap;[^}]*\}/,
  );
  assert.match(
    css,
    /\.nav-item\s+i\s*\{[^}]*flex:\s*0\s+0\s+1\.25rem;[^}]*font-size:\s*1rem;[^}]*\}/,
  );
  assert.match(
    css,
    /\.sidebar-collapsed\s+\.sidebar-header\s*\{[^}]*flex-direction:\s*column;[^}]*\}/,
  );
  assert.match(
    css,
    /\.sidebar-collapsed\s+\.nav-item\s*\{[^}]*width:\s*48px;[^}]*justify-content:\s*center;[^}]*\}/,
  );
  assert.doesNotMatch(
    css,
    /\.sidebar-collapsed\s+\.sidebar-toggle\s*\{[^}]*position:\s*absolute;/,
  );
});

test('shared sidebar renders consistent icons and active states for all six pages', async () => {
  for (const page of pages) {
    const html = await ejs.renderFile(sidebarPath, {
      user: { role: 'admin' },
      activePage: page.active,
    });

    for (const [href, label] of adminLinks) {
      const anchor = html.match(
        new RegExp(`<a\\s+href="${href}"[\\s\\S]*?>([\\s\\S]*?)<\\/a\\s*>`),
      );
      assert.ok(anchor, `${page.name} is missing ${label}`);
      assert.match(
        anchor[1],
        /<i class="fas [^"]+" aria-hidden="true"><\/i\s*>/,
      );
      assert.match(
        anchor[1],
        new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
      );
      assert.equal(
        anchor[0].includes('aria-current="page"'),
        href ===
          (page.active === 'dashboard'
            ? '/dashboard'
            : page.active === 'patients'
              ? '/patients'
              : page.active === 'staff'
                ? '/admin/staff'
                : page.active === 'reports'
                  ? '/admin/reports'
                  : '/admin/recovery'),
      );
    }
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
    assert.match(html, /data-sidebar-toggle/);
    assert.match(html, /aria-label="Collapse navigation"/);
    for (const [, label] of adminLinks) {
      assert.match(html, new RegExp(`aria-label="${label}"`));
      assert.match(html, new RegExp(`title="${label}"`));
    }
  }
});

test('non-admin sidebar never renders admin-only destinations', async () => {
  const html = await ejs.renderFile(sidebarPath, {
    user: { role: 'staff' },
    activePage: 'patients',
  });

  assert.match(html, /href="\/dashboard"/);
  assert.match(html, /href="\/patients"/);
  assert.match(html, /href="\/account\/password"/);
  assert.doesNotMatch(html, /href="\/admin\/(?:staff|reports|recovery)"/);
});
