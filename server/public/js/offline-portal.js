(function () {
  const pageTitle = document.getElementById('offlinePageTitle');
  const accountLabel = document.getElementById('offlinePageAccount');
  const connectionLabel = document.getElementById('offlinePageConnection');
  const retryButton = document.getElementById('offlinePageRetry');
  const openOnlineButton = document.getElementById('offlinePageOpenOnline');
  const lockedPanel = document.getElementById('offlinePageLocked');
  const lockedTitle = document.getElementById('offlinePageLockedTitle');
  const lockedMessage = document.getElementById('offlinePageLockedMessage');
  const content = document.getElementById('offlinePageContent');
  const statusMessage = document.getElementById('offlinePageStatus');
  const pageByPath = {
    '/dashboard': { title: 'Dashboard', adminOnly: false },
    '/admin/staff': { title: 'Staff', adminOnly: true },
    '/admin/reports': { title: 'Reports', adminOnly: true },
    '/admin/recovery': { title: 'Data recovery', adminOnly: true },
  };
  const page = pageByPath[location.pathname];
  let context = null;
  let serverVerified = false;

  function setStatus(message, error = false) {
    statusMessage.textContent = message || '';
    statusMessage.classList.toggle('offline-portal-error', error);
  }

  function lockAccess(title, message) {
    context = null;
    serverVerified = false;
    content.hidden = true;
    content.replaceChildren();
    accountLabel.textContent = '';
    openOnlineButton.hidden = true;
    lockedTitle.textContent = title;
    lockedMessage.textContent = message;
    lockedPanel.hidden = false;
    document.querySelectorAll('[data-admin-link]').forEach((link) => {
      link.hidden = true;
    });
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function metricCard(title, value, description) {
    const card = element('article', 'offline-portal-card');
    card.append(
      element('h2', '', title),
      element('strong', 'offline-portal-value', value),
    );
    if (description) card.append(element('p', '', description));
    return card;
  }

  function formatTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Timestamp unavailable'
      : date.toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
  }

  function appendQueueCard(queue, metadata) {
    const card = element('article', 'offline-portal-card');
    card.append(element('h2', '', 'Synchronization'));
    const list = element('ul', 'offline-portal-list');
    for (const [label, value] of [
      ['Pending', queue.pending],
      ['Processing', queue.processing],
      ['Failed / review required', queue.failed],
      ['Conflicts', queue.conflicts],
    ]) {
      const row = element('li');
      row.append(
        element('span', '', label),
        element('strong', '', String(value)),
      );
      list.append(row);
    }
    card.append(list);
    card.append(
      element(
        'p',
        '',
        `Last successful sync: ${metadata.lastSuccessfulAt ? formatTimestamp(metadata.lastSuccessfulAt) : 'Never recorded'}`,
      ),
    );
    card.append(
      element(
        'p',
        '',
        `Latest local sync attempt: ${metadata.lastAttemptAt ? `${formatTimestamp(metadata.lastAttemptAt)}${metadata.lastOutcome ? ` · ${metadata.lastOutcome}` : ''}` : 'Never recorded'}`,
      ),
    );
    const actions = element('div', 'offline-portal-actions');
    const sync = element('button', 'btn-primary', 'Sync pending changes');
    sync.type = 'button';
    sync.disabled = !navigator.onLine || !serverVerified || queue.total === 0;
    sync.addEventListener('click', () => void synchronize(sync));
    actions.append(sync);
    card.append(actions);
    return card;
  }

  async function renderDashboard() {
    const patients = await window.db.getPatients();
    const queue = await window.db.getQueueStatus();
    const metadata = window.db.getSyncMetadata();
    const snapshot = await window.db.getDashboardMetrics();
    const active = patients.filter(
      (patient) => patient.is_deleted === false || patient.is_deleted === 0,
    ).length;
    const deleted = patients.filter(
      (patient) => patient.is_deleted === true || patient.is_deleted === 1,
    ).length;
    const grid = element('div', 'offline-portal-grid');
    const patientCard = element('article', 'offline-portal-card');
    patientCard.append(element('h2', '', 'Patient records on this device'));
    const patientList = element('ul', 'offline-portal-list');
    for (const [label, value] of [
      ['Stored records', patients.length],
      ['Known active', active],
      ['Known soft-deleted', deleted],
    ]) {
      const row = element('li');
      row.append(
        element('span', '', label),
        element('strong', '', String(value)),
      );
      patientList.append(row);
    }
    patientCard.append(patientList);
    patientCard.append(
      element(
        'p',
        '',
        'These are only records available in this browser profile; this may be an incomplete snapshot, not the database total.',
      ),
    );
    grid.append(patientCard);

    if (snapshot?.metrics) {
      const cached = snapshot.metrics;
      if (cached.staff && context.role === 'admin') {
        const staffCard = element('article', 'offline-portal-card');
        staffCard.append(
          element('h2', '', 'Last server staff snapshot'),
          element(
            'p',
            '',
            `Total ${cached.staff.total ?? 'Unavailable'} · Active ${cached.staff.active ?? 'Unavailable'} · Inactive ${cached.staff.inactive ?? 'Unavailable'}`,
          ),
          element(
            'p',
            '',
            `Last updated ${formatTimestamp(snapshot.savedAt)}. Stale data; not a live count.`,
          ),
        );
        grid.append(staffCard);
      }
      const patientSnapshot = cached.patients;
      if (patientSnapshot) {
        const snapshotCard = element('article', 'offline-portal-card');
        snapshotCard.append(element('h2', '', 'Last server patient metrics'));
        const list = element('ul', 'offline-portal-list');
        for (const [label, value] of [
          ['Total', patientSnapshot.total],
          ['Active', patientSnapshot.active],
          ['Deleted', patientSnapshot.deleted],
        ]) {
          const row = element('li');
          row.append(
            element('span', '', label),
            element(
              'strong',
              '',
              value === null || value === undefined
                ? 'Unavailable'
                : String(value),
            ),
          );
          list.append(row);
        }
        snapshotCard.append(
          list,
          element(
            'p',
            '',
            `Server snapshot saved ${formatTimestamp(snapshot.savedAt)}; it may be stale.`,
          ),
        );
        grid.append(snapshotCard);
      }
    } else if (context.role === 'admin') {
      grid.append(
        metricCard(
          'Server-only metrics',
          'Unavailable',
          'No server metrics snapshot is stored for this account.',
        ),
      );
    }

    grid.append(appendQueueCard(queue, metadata));
    return grid;
  }

  function parseRecordDate(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function renderLocalReports(patients) {
    const active = patients.filter(
      (patient) => patient.is_deleted === false || patient.is_deleted === 0,
    );
    const deleted = patients.filter(
      (patient) => patient.is_deleted === true || patient.is_deleted === 1,
    );
    const unknown = patients.length - active.length - deleted.length;
    const genderCounts = new Map();
    for (const patient of active) {
      const label =
        typeof patient.gender === 'string' && patient.gender.trim()
          ? patient.gender.trim()
          : 'Unspecified';
      genderCounts.set(label, (genderCounts.get(label) || 0) + 1);
    }
    const grid = element('div', 'offline-portal-grid');
    const summary = element('article', 'offline-portal-card');
    summary.append(
      element('h2', '', 'Patient snapshot on this device'),
      element(
        'p',
        '',
        'Locally computed from records currently stored in this browser. This dataset may be incomplete and is not a substitute for the database-backed report.',
      ),
    );
    const list = element('ul', 'offline-portal-list');
    for (const [label, value] of [
      ['Stored records', patients.length],
      ['Known active', active.length],
      ['Known soft-deleted', deleted.length],
      ['Status unavailable', unknown],
    ]) {
      const row = element('li');
      row.append(
        element('span', '', label),
        element('strong', '', String(value)),
      );
      list.append(row);
    }
    summary.append(list);
    grid.append(summary);

    const genderCard = element('article', 'offline-portal-card');
    genderCard.append(
      element('h2', '', 'Gender of locally stored active records'),
    );
    if (genderCounts.size) {
      const genders = element('ul', 'offline-portal-list');
      for (const [label, count] of [...genderCounts].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const row = element('li');
        row.append(
          element('span', '', label),
          element('strong', '', String(count)),
        );
        genders.append(row);
      }
      genderCard.append(genders);
    } else {
      genderCard.append(
        element('p', '', 'No locally stored active records are available.'),
      );
    }
    grid.append(genderCard);

    const trendCard = element('article', 'offline-portal-card');
    trendCard.append(
      element('h2', '', 'Registration dates in the local snapshot'),
      element(
        'p',
        '',
        'Only active local records with a valid creation timestamp are included. URL date-range filters are not applied; this is not a complete server trend.',
      ),
    );
    const counts = new Map();
    let missingDates = 0;
    for (const patient of active) {
      const date = parseRecordDate(patient.created_at);
      if (!date) {
        missingDates++;
        continue;
      }
      const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (counts.size) {
      const chart = element('div', 'offline-portal-chart');
      const max = Math.max(...counts.values());
      for (const [key, count] of [...counts].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const month = element('div', 'offline-portal-month');
        month.append(element('span', '', String(count)));
        const track = element('div', 'offline-portal-bar-track');
        const bar = element('span', 'offline-portal-bar');
        bar.style.height = `${Math.max(3, Math.round((count / max) * 100))}%`;
        bar.setAttribute(
          'aria-label',
          `${key}: ${count} locally stored registration(s)`,
        );
        track.append(bar);
        month.append(track, element('span', '', key));
        chart.append(month);
      }
      trendCard.append(chart);
    } else {
      trendCard.append(
        element(
          'p',
          '',
          'No valid local creation timestamps are available to chart.',
        ),
      );
    }
    if (missingDates) {
      trendCard.append(
        element(
          'p',
          '',
          `${missingDates} active local record(s) had no usable creation timestamp and are omitted from the chart.`,
        ),
      );
    }
    grid.append(trendCard);
    grid.append(
      metricCard(
        'Server-only report data',
        'Unavailable',
        'Staff-account totals, sync-log history, and complete database-wide counts require a connection.',
      ),
    );
    return grid;
  }

  async function renderPage() {
    if (!page || !window.db) {
      setStatus('This offline page is not available.', true);
      return;
    }
    content.replaceChildren();
    try {
      if (page.title === 'Dashboard') {
        content.append(await renderDashboard());
      } else if (page.title === 'Staff') {
        content.append(
          metricCard(
            'Staff directory unavailable offline',
            'Not stored',
            'Staff records and account changes are not stored on this device. Reconnect to view or manage staff. No offline staff changes are supported.',
          ),
        );
      } else if (page.title === 'Data recovery') {
        content.append(
          metricCard(
            'Data recovery requires a connection',
            'Unavailable offline',
            'Backup download and restore require the authenticated server page. Local patient snapshots and queued changes remain in this browser; no recovery operation was started.',
          ),
        );
      } else {
        const patients = await window.db.getPatients();
        content.append(renderLocalReports(patients));
      }
      content.hidden = false;
    } catch (error) {
      console.error(
        '[OFFLINE PORTAL] Could not render local page data:',
        error,
      );
      content.replaceChildren(
        element(
          'p',
          'offline-portal-error',
          'Local information could not be read. No records or queued changes were removed.',
        ),
      );
      content.hidden = false;
    }
  }

  async function verifySession() {
    openOnlineButton.hidden = true;
    if (!navigator.onLine) {
      connectionLabel.textContent = 'Offline · local information only';
      serverVerified = false;
      await renderPage();
      return false;
    }
    connectionLabel.textContent = 'Checking HealthSys session…';
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch('/session/status', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.status === 401) {
        window.HealthSysOfflineAccess.clear();
        lockAccess(
          'Sign in required',
          'HealthSys confirmed that this session is no longer valid. Sign in online before accessing local information.',
        );
        connectionLabel.textContent = 'Session expired';
        return false;
      }
      if (!response.ok) {
        serverVerified = false;
        connectionLabel.textContent = `Server unavailable · HTTP ${response.status}`;
        return false;
      }
      const session = await response.json();
      if (
        session?.authenticated !== true ||
        !session.user?.id ||
        session.user.id !== context.userId
      ) {
        window.HealthSysOfflineAccess.clear();
        lockAccess(
          'Sign in required',
          'The server could not verify the previously authorized account. Sign in again to continue.',
        );
        connectionLabel.textContent = 'Session not verified';
        return false;
      }
      if (session.csrfToken)
        document.body.dataset.csrfToken = session.csrfToken;
      window.HealthSysOfflineAccess.save(session.user);
      context = window.HealthSysOfflineAccess.read();
      if (page.adminOnly && context.role !== 'admin') {
        window.HealthSysOfflineAccess.clear();
        lockAccess(
          'Administrator access required',
          'HealthSys no longer confirms administrator access for this account.',
        );
        connectionLabel.textContent = 'Administrator access required';
        return false;
      }
      document.querySelectorAll('[data-admin-link]').forEach((link) => {
        link.hidden = context.role !== 'admin';
      });
      serverVerified = true;
      connectionLabel.textContent = 'Connected · session verified';
      openOnlineButton.hidden = false;
      await renderPage();
      return true;
    } catch (error) {
      serverVerified = false;
      connectionLabel.textContent =
        error?.name === 'AbortError'
          ? 'Server check timed out · local information remains available'
          : 'Server unreachable · local information remains available';
      return false;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function synchronize(button) {
    button.disabled = true;
    setStatus('Verifying session before synchronization…');
    try {
      if (!(await verifySession())) {
        setStatus(
          'Synchronization is unavailable until HealthSys verifies your session.',
          true,
        );
        return;
      }
      const result = await window.db.syncPendingData();
      if (result.success || result.processed > 0) {
        const response = await fetch('/patients/json', {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok)
          throw new Error(
            `Patient refresh failed with HTTP ${response.status}.`,
          );
        const records = await response.json();
        if (!Array.isArray(records))
          throw new Error('HealthSys returned an invalid patient list.');
        await window.db.savePatients(records);
      }
      setStatus(
        result.success
          ? 'Synchronization completed; HealthSys confirmed the result.'
          : result.error || 'Some operations remain queued or need review.',
        !result.success,
      );
      await renderPage();
    } catch (error) {
      setStatus(
        `Synchronization did not complete. Queued changes were retained. ${error.message || ''}`,
        true,
      );
    } finally {
      await renderPage();
    }
  }

  async function initialize() {
    if (!page) {
      lockAccess(
        'Page unavailable',
        'This page does not have an offline view.',
      );
      return;
    }
    document.title = `${page.title} | HealthSys Offline`;
    pageTitle.textContent = page.title;
    const activeNav = document.querySelector(
      `[data-nav="${page.title.toLowerCase()}"]`,
    );
    if (activeNav) activeNav.setAttribute('aria-current', 'page');
    try {
      const ready = await window.healthsysDBReady;
      const savedContext = window.HealthSysOfflineAccess.read();
      if (!ready || !savedContext) {
        lockAccess(
          'Offline access is unavailable',
          !savedContext
            ? 'Sign in while connected to establish offline access for this account.'
            : window.healthsysDBError || 'Local storage could not be opened.',
        );
        return;
      }
      context = savedContext;
      if (page.adminOnly && context.role !== 'admin') {
        lockAccess(
          'Administrator access required',
          'This page is available offline only to an administrator previously verified on this device.',
        );
        return;
      }
      window.db.setOfflineUser(context.userId);
      accountLabel.textContent = `${context.username || 'Previously signed-in account'} · local view`;
      document.querySelectorAll('[data-admin-link]').forEach((link) => {
        link.hidden = context.role !== 'admin';
      });
      lockedPanel.hidden = true;
      await renderPage();
      if (navigator.onLine) await verifySession();
      else connectionLabel.textContent = 'Offline · local information only';
    } catch (error) {
      console.error('[OFFLINE PORTAL] Initialization failed:', error);
      lockAccess(
        'Offline view unavailable',
        'HealthSys could not open this local view. Stored records and queued changes were not removed.',
      );
    }
  }

  retryButton.addEventListener('click', () => {
    void verifySession();
  });
  openOnlineButton.addEventListener('click', () => {
    if (serverVerified) location.assign(location.href);
  });
  window.addEventListener('online', () => {
    void verifySession();
  });
  window.addEventListener('offline', () => {
    serverVerified = false;
    openOnlineButton.hidden = true;
    connectionLabel.textContent = 'Offline · local information only';
    void renderPage();
  });
  void initialize();
})();
