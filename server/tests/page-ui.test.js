const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const test = require('node:test');

const viewsDirectory = path.join(__dirname, '..', 'views');
const styles = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'patient-dashboard-refresh.css'),
  'utf8',
);
const sharedStyles = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'ui-modernization.css'),
  'utf8',
);
const appStyles = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'style.css'),
  'utf8',
);

async function renderPatientsPage(query = {}) {
  return ejs.renderFile(path.join(viewsDirectory, 'patients.ejs'), {
    user: { id: 'synthetic-user', username: 'Synthetic', role: 'admin' },
    csrfToken: 'synthetic-csrf',
    csvMaxBytes: 2 * 1024 * 1024,
    query,
    patients: [
      {
        id: '12345678-1234-4234-8234-123456789012',
        full_name: 'Synthetic Patient',
        date_of_birth: '1990-01-02',
        gender: 'female',
        phone: '+15555550123',
        is_deleted: false,
        version: 1,
      },
    ],
    counts: { total: 12, filtered: 1 },
    pagination: { page: 2, pages: 3 },
    error: null,
    message: null,
  });
}

async function renderDashboardPage(role = 'admin') {
  return ejs.renderFile(path.join(viewsDirectory, 'dashboard.ejs'), {
    user: { id: 'synthetic-user', username: 'Synthetic', role },
    csrfToken: 'synthetic-csrf',
    metrics: {
      patients: { total: 12, active: 10, deleted: 2 },
      staff: { total: 5, active: 4, inactive: 1 },
      lastSuccessfulSyncAt: null,
      lastSyncAttemptAt: null,
      lastAttemptOutcome: 'partial',
      recentPatients: [
        {
          id: 'patient-id',
          full_name: 'Recent Synthetic Patient',
          created_at: '2026-10-17T10:00:00.000Z',
          is_deleted: 0,
        },
      ],
      recentActivity: [
        {
          action: 'patient.create',
          outcome: 'success',
          actor_role: 'staff',
          actor_name: 'Synthetic staff',
          created_at: '2026-10-17T10:05:00.000Z',
        },
      ],
    },
    metricsError: null,
  });
}

async function renderPatientProfile() {
  return ejs.renderFile(path.join(viewsDirectory, 'patient-profile.ejs'), {
    user: { id: 'synthetic-user', username: 'Synthetic', role: 'admin' },
    csrfToken: 'synthetic-csrf',
    patient: {
      id: '12345678-1234-4234-8234-123456789012',
      full_name: 'Synthetic Patient',
      date_of_birth: '1990-01-02',
      gender: 'female',
      phone: '+15555550123',
      address: 'Synthetic address',
      is_deleted: false,
      version: 1,
      created_at: '2025-01-01T12:00:00.000Z',
      updated_at: '2025-01-02T12:00:00.000Z',
    },
    visits: [],
    visitsError: false,
    visitPagination: { page: 1, pages: 1, total: 0, pageSize: 20 },
    latestVitals: null,
    appointments: [],
    appointmentOperationId: '12345678-1234-4234-8234-123456789012',
    staff: [],
    notes: [
      {
        id: 1,
        note: 'Synthetic attributed note',
        author_name: 'Synthetic clinician',
        created_at: '2025-01-02T12:00:00.000Z',
      },
    ],
    activity: [],
    completenessWarnings: ['Address'],
    generatedAt: new Date('2025-02-01T12:00:00.000Z'),
    returnTo: '/patients',
    query: {},
    error: null,
  });
}

test('patients page renders grouped filters, removable chips, and pagination fields', async () => {
  const html = await renderPatientsPage({
    search: 'Synthetic',
    gender: 'female',
    status: 'all',
    fromDate: '1980-01-01',
    toDate: '2000-01-01',
    sort: 'name',
    direction: 'ASC',
    pageSize: '10',
    page: '2',
  });

  for (const name of [
    'search',
    'gender',
    'status',
    'fromDate',
    'toDate',
    'sort',
    'direction',
    'pageSize',
  ]) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
  assert.match(html, /Search by patient name, ID, or phone/);
  assert.match(
    html,
    /Patient details[\s\S]*Record status[\s\S]*Date of birth[\s\S]*Sort and display/,
  );
  assert.match(html, /Gender: Female/);
  assert.match(html, /Status: All records/);
  assert.match(html, /Clear all/);
  assert.match(
    html,
    /Showing <strong>1<\/strong> matching record\(s\) of <strong>12<\/strong>/,
  );
  assert.match(html, /name="pageSize"[^>]*>[\s\S]*<option value="10" selected/);
  assert.match(html, /href="\/patients\?[^"]*page=3/);
  const genderChip = html.match(
    /<a class="filter-chip" href="([^"]+)">Gender: Female/,
  );
  assert.ok(genderChip);
  const genderRemoval = new URL(
    genderChip[1].replaceAll('&amp;', '&'),
    'http://localhost',
  );
  assert.equal(genderRemoval.searchParams.has('gender'), false);
  assert.equal(genderRemoval.searchParams.get('search'), 'Synthetic');
  assert.equal(genderRemoval.searchParams.get('status'), 'all');
  assert.equal(genderRemoval.searchParams.has('page'), false);
  const searchChip = html.match(
    /<a class="filter-chip" href="([^"]+)">Search: Synthetic/,
  );
  assert.ok(searchChip);
  const searchRemoval = new URL(
    searchChip[1].replaceAll('&amp;', '&'),
    'http://localhost',
  );
  assert.equal(searchRemoval.searchParams.has('search'), false);
  assert.equal(searchRemoval.searchParams.get('gender'), 'female');
  assert.match(html, /Sort: Name/);
  assert.match(html, /Order: Ascending/);
  assert.match(html, /<option value="asc" selected>Ascending/);
  assert.match(html, /Rows: 10/);
  assert.match(html, /class="patient-filter-disclosure"/);
  assert.match(html, /href="\/patients" class="btn-reset">Reset all/);
  assert.match(html, /patient-export-menu/);
  assert.match(html, /Export filtered results \(all pages\)/);
  assert.match(html, /Export all active records/);
  assert.match(html, /Export all records including deleted/);
  assert.match(html, /Import patients from CSV/);
  assert.match(html, /Download CSV template/);
  assert.match(
    html,
    /data-copy-patient-id="12345678-1234-4234-8234-123456789012"/,
  );
  assert.match(html, /aria-label="Copy full patient ID"/);
  assert.match(
    html,
    /tabindex="0" role="region" aria-label="Patient records table"/,
  );
});

test('patient profile includes accessible clinical details and print timestamp', async () => {
  const html = await renderPatientProfile();
  assert.match(
    html,
    /Record completeness is based on the required registration fields: Name, Date of birth, Gender, Phone, and Address\. Missing: Address/,
  );
  assert.match(html, /Synthetic attributed note/);
  assert.match(html, /Synthetic clinician/);
  assert.match(html, /Notes are append-only/);
  assert.match(html, /Summary generated/);
  assert.match(
    html,
    /patients\/notes\/add\/12345678-1234-4234-8234-123456789012/,
  );
});

test('responsive tables remain keyboard reachable and focus styles respect motion settings', async () => {
  const patientsHtml = await renderPatientsPage();
  const appointments = fs.readFileSync(
    path.join(viewsDirectory, 'appointments.ejs'),
    'utf8',
  );
  const staff = fs.readFileSync(
    path.join(viewsDirectory, 'admin', 'staff.ejs'),
    'utf8',
  );
  const profile = fs.readFileSync(
    path.join(viewsDirectory, 'patient-profile.ejs'),
    'utf8',
  );

  assert.match(
    patientsHtml,
    /tabindex="0" role="region" aria-label="Patient records table"/,
  );
  assert.match(
    appointments,
    /tabindex="0" role="region" aria-label="Appointment list"/,
  );
  assert.match(
    staff,
    /tabindex="0" role="region" aria-label="Staff accounts table"/,
  );
  assert.match(
    profile,
    /tabindex="0" role="region" aria-label="Visit history for/,
  );
  assert.match(appStyles, /\.table-container\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(appStyles, /:focus-visible\s*\{/);
  assert.match(appStyles, /@media\s*\(max-width:\s*700px\)/);
  assert.match(appStyles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test('patient action buttons share fixed dimensions and retain profile/delete actions', async () => {
  const html = await renderPatientsPage({ status: 'active' });
  const actions =
    html.match(
      /class="btn-action patient-action patient-action-(?:profile|delete)"[^>]*>[\s\S]*?<\/(?:a|button)>/g,
    ) || [];
  assert.equal(actions.length, 2);
  assert.match(
    html,
    /href="\/patients\/12345678-1234-4234-8234-123456789012\?returnTo=/,
  );
  const profileLink = html.match(
    /href="\/patients\/12345678-1234-4234-8234-123456789012\?returnTo=([^"]+)"/,
  );
  assert.ok(profileLink);
  const returnParams = new URLSearchParams(`returnTo=${profileLink[1]}`);
  assert.equal(returnParams.get('returnTo'), '/patients?status=active&page=2');
  assert.match(html, /data-action="delete"/);
  assert.match(
    styles,
    /\.patient-actions \.patient-action\s*\{[\s\S]*?width:\s*6\.5rem;[\s\S]*?min-width:\s*6\.5rem;[\s\S]*?height:\s*2\.5rem;[\s\S]*?min-height:\s*2\.5rem;[\s\S]*?padding:\s*0 0\.65rem;[\s\S]*?font-size:\s*0\.82rem;/,
  );
  assert.match(
    styles,
    /\.patient-filter-panel\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?box-sizing:\s*border-box;[\s\S]*?max-height:\s*min\(70vh,\s*42rem\);[\s\S]*?overflow-y:\s*auto;/,
  );
  assert.match(
    styles,
    /\.patient-filter-disclosure\s*>\s*summary\s*\{[\s\S]*?box-sizing:\s*border-box;/,
  );
  assert.match(
    styles,
    /@media\s*\(min-width:\s*701px\)\s*and\s*\(max-width:\s*1024px\)\s*\{[\s\S]*?\.patient-filter-panel\s*\{[\s\S]*?width:\s*min\(760px,\s*calc\(100vw\s*-\s*320px\)\);/,
  );
  assert.match(
    styles,
    /@media\s*\(max-width:\s*1024px\)\s*\{[\s\S]*?\.patient-filter-panel\s*\{[\s\S]*?top:\s*auto;[\s\S]*?bottom:\s*calc\(100%\s*\+\s*0\.5rem\);/,
  );
  assert.match(
    styles,
    /@media\s*\(max-width:\s*700px\)[\s\S]*?\.patient-toolbar\s*\{[\s\S]*?grid-template-columns/,
  );
  assert.match(
    styles,
    /@media\s*\(max-width:\s*700px\)[\s\S]*?\.offline-recovery-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr/,
  );
});

test('shared redesign stylesheet loads separately and is cached with the app shell', async () => {
  const patientsHtml = await renderPatientsPage();
  const dashboardHtml = await renderDashboardPage();
  const serviceWorker = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'service-worker.js'),
    'utf8',
  );
  assert.match(patientsHtml, /href="\/patient-dashboard-refresh\.css"/);
  assert.match(dashboardHtml, /href="\/patient-dashboard-refresh\.css"/);
  for (const html of [patientsHtml, dashboardHtml]) {
    assert.match(html, /href="\/ui-modernization\.css"/);
  }
  assert.match(serviceWorker, /['"]\/ui-modernization\.css['"]/);
  assert.match(
    sharedStyles,
    /--primary-color:\s*#2563eb;[\s\S]*--background-start:\s*#f1f5f9;/,
  );
  assert.match(
    sharedStyles,
    /\.report-kpis\s*\{[\s\S]*grid-template-columns:\s*repeat\(4/,
  );
  assert.match(
    sharedStyles,
    /\.staff-create-form\s*\{[\s\S]*grid-template-columns/,
  );
});

test('shared typography tokens prevent route-specific recovery table scaling', () => {
  const recovery = fs.readFileSync(
    path.join(viewsDirectory, 'admin', 'data-recovery.ejs'),
    'utf8',
  );
  assert.match(sharedStyles, /--font-family-app:/);
  assert.match(sharedStyles, /--font-size-body:\s*0\.9375rem/);
  assert.match(sharedStyles, /--line-height-body:\s*1\.5/);
  assert.match(
    sharedStyles,
    /\.recovery-page\s*\{[\s\S]*font-family:\s*var\(--font-family-app\)/,
  );
  assert.match(
    sharedStyles,
    /\.recovery-table\s*\{[\s\S]*font-size:\s*var\(--font-size-table\)/,
  );
  assert.doesNotMatch(recovery, /\.recovery-table\s*\{\s*font-size:\s*\.82rem/);
  assert.match(recovery, /fonts\.googleapis\.com\/css2\?family=Inter/);
});

test('Admin recovery provides searchable paginated audit history', () => {
  const recovery = fs.readFileSync(
    path.join(viewsDirectory, 'admin', 'data-recovery.ejs'),
    'utf8',
  );
  const auditClient = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'admin-audit.js'),
    'utf8',
  );
  for (const id of [
    'audit-filters',
    'audit-events',
    'audit-status',
    'audit-page',
    'audit-previous',
    'audit-next',
  ]) {
    assert.match(recovery, new RegExp(`id="${id}"`));
  }
  for (const name of ['action', 'actor', 'entity', 'from', 'to', 'outcome']) {
    assert.match(recovery, new RegExp(`name="${name}"`));
  }
  assert.match(recovery, /\/js\/admin-audit\.js/);
  assert.match(auditClient, /\/admin\/recovery\/audit\/events/);
  assert.match(auditClient, /credentials:\s*'same-origin'/);
  assert.match(auditClient, /textCell\(row, diagnostic\)/);
});

test('reports provide an inclusive UTC range, reset, and range-matched CSV export', () => {
  const reports = fs.readFileSync(
    path.join(viewsDirectory, 'admin', 'reports.ejs'),
    'utf8',
  );
  const adminRoutes = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'admin.js'),
    'utf8',
  );
  assert.match(reports, /Start date \(UTC\)/);
  assert.match(reports, /End date \(UTC, inclusive\)/);
  assert.match(reports, /href="\/admin\/reports\?range=30d">Reset/);
  assert.match(reports, /\/admin\/reports\/registrations\.csv\?/);
  assert.match(
    reports,
    /reportExportParams\.set\('fromDate', dateRange\.fromDate\)/,
  );
  assert.match(
    reports,
    /reportExportParams\.set\('toDate', dateRange\.toDate\)/,
  );
  assert.match(adminRoutes, /router\.get\('\/reports\/registrations\.csv'/);
  assert.match(adminRoutes, /created_at >= \?/);
  assert.match(adminRoutes, /created_at < \?/);
  assert.match(adminRoutes, /is_deleted = FALSE/);
  assert.match(adminRoutes, /LIMIT \? OFFSET \?/);
});

test('dashboard groups existing metrics and preserves sync and recovery controls', async () => {
  const html = await renderDashboardPage();
  assert.equal(
    (html.match(/class="overview-group(?: overview-sync-group)?"/g) || [])
      .length,
    3,
  );
  for (const id of [
    'patientTotal',
    'patientActive',
    'patientDeleted',
    'staffTotal',
    'staffActive',
    'staffInactive',
    'queueCount',
    'queueDetails',
    'lastSuccessfulSync',
    'lastSyncAttempt',
    'syncOutcome',
    'syncButton',
    'failedReview',
    'conflictReview',
    'exportOfflineBackup',
    'importOfflineBackup',
    'restoreOfflineBackup',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} remains available`);
  }
  assert.match(html, /id="patientTotal">12/);
  assert.match(html, /id="patientActive">10/);
  assert.match(html, /id="patientDeleted">2/);
  assert.match(html, /id="staffTotal">5/);
  assert.match(html, /id="staffActive">4/);
  assert.match(html, /id="staffInactive">1/);
  assert.match(html, /id="syncOutcome">Idle/);
  assert.match(html, /not encrypted/);
  assert.match(html, /Recently registered patients/);
  assert.match(html, /Recent Synthetic Patient/);
  assert.match(html, /Recent staff activity/);
  assert.match(html, /Patient record created/);
  assert.match(html, /id="localBackupStatus"/);
  const offlineRecovery = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'offline-recovery.js'),
    'utf8',
  );
  assert.match(
    offlineRecovery,
    /file's current location and availability cannot be verified/,
  );
});

test('non-admin dashboard omits restricted staff metrics', async () => {
  const html = await renderDashboardPage('staff');
  assert.doesNotMatch(html, /id="staff(?:Total|Active|Inactive)"/);
  assert.doesNotMatch(html, /href="\/admin\/staff"/);
});

test('staff account form and actions retain safe constraints and clear states', () => {
  const staff = fs.readFileSync(
    path.join(viewsDirectory, 'admin', 'staff.ejs'),
    'utf8',
  );
  assert.match(staff, /class="staff-create-form"/);
  assert.match(staff, /minlength="3" maxlength="32"/);
  assert.match(staff, /minlength="12" maxlength="72"/);
  assert.match(staff, /data-password-toggle="new-password"/);
  assert.match(staff, /class="staff-actions"/);
  assert.match(staff, /data-confirm="Disable/);
  assert.match(staff, /class="staff-security-panel"/);
  assert.match(staff, /status-pill-active/);
  assert.match(staff, /status-pill-disabled/);
});

test('dashboard queue presentation keeps failed and conflicted work distinct', () => {
  const dashboardScript = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'dashboard.js'),
    'utf8',
  );
  assert.match(
    dashboardScript,
    /queue\.pending\} pending · \$\{queue\.processing\} processing · \$\{queue\.conflicts \|\| 0\} conflicts · \$\{queue\.failed\} failed/,
  );
  assert.match(dashboardScript, /queue-details-attention/);
});
