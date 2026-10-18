(function () {
  let activeSync = null;
  const recordsChannel =
    typeof BroadcastChannel === 'function'
      ? new BroadcastChannel('healthsys-records')
      : null;

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  }

  function formatTimestamp(value) {
    if (window.HealthSysUI?.formatTimestamp)
      return window.HealthSysUI.formatTimestamp(value);
    if (!value) return 'Never';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Not available'
      : `${date.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC`;
  }

  function setSyncOutcome(status, message) {
    const statusElement = document.getElementById('syncOutcome');
    const messageElement = document.getElementById('syncMessage');
    if (statusElement) statusElement.textContent = status;
    if (messageElement) messageElement.textContent = message || '';
  }

  function renderSyncMetadata(metadata = {}) {
    const serverTimes = document.getElementById('serverSyncTimes');
    const latestTimestamp = (localValue, serverValue) => {
      const values = [localValue, serverValue].filter(Boolean);
      return (
        values.sort((left, right) => new Date(right) - new Date(left))[0] || ''
      );
    };
    const lastSuccess = latestTimestamp(
      metadata.lastSuccessfulAt,
      serverTimes && serverTimes.dataset.successful,
    );
    const lastAttempt = latestTimestamp(
      metadata.lastAttemptAt,
      serverTimes && serverTimes.dataset.attempt,
    );
    const localIsLatest =
      metadata.lastAttemptAt &&
      (!serverTimes?.dataset.attempt ||
        new Date(metadata.lastAttemptAt) >=
          new Date(serverTimes.dataset.attempt));
    setText(
      'lastSuccessfulSync',
      formatTimestamp(lastSuccess) === 'Not available'
        ? 'Never'
        : formatTimestamp(lastSuccess),
    );
    setText(
      'lastSyncAttempt',
      formatTimestamp(lastAttempt) === 'Not available'
        ? 'Never'
        : formatTimestamp(lastAttempt),
    );

    const outcome = localIsLatest
      ? metadata.lastOutcome
      : serverTimes?.dataset.outcome;
    const lastError = localIsLatest ? metadata.lastError : '';
    if (outcome) {
      const messages = {
        'In Progress': 'Synchronization is in progress.',
        Success: 'The latest attempt completed successfully.',
        'Partial Failure':
          lastError || 'Some operations remain unconfirmed and queued.',
        Failure:
          lastError ||
          'The latest attempt failed; queued changes are retained.',
        Unknown:
          'The server recorded an attempt, but its outcome is unavailable.',
      };
      setSyncOutcome(outcome, messages[outcome] || '');
    }
  }

  async function updateQueueCount() {
    const countElement = document.getElementById('queueCount');
    const detailsElement = document.getElementById('queueDetails');
    if (!countElement || !window.db || !window.db.getQueueStatus) return;

    try {
      const queue = await window.db.getQueueStatus();
      countElement.textContent = String(queue.total);
      if (detailsElement) {
        detailsElement.textContent = `${queue.pending} pending · ${queue.processing} processing · ${queue.conflicts || 0} conflicts · ${queue.failed} failed`;
        detailsElement.classList?.toggle(
          'queue-details-attention',
          queue.failed > 0 || queue.conflicts > 0,
        );
      }
      countElement.dataset.available = 'true';
      await Promise.all([renderConflicts(), renderFailedOperations()]);
    } catch (error) {
      console.error('[DASHBOARD] Unable to read IndexedDB sync queue:', error);
      countElement.textContent = 'Unavailable';
      if (detailsElement)
        detailsElement.textContent =
          'Local synchronization queue could not be read.';
      detailsElement?.classList?.remove('queue-details-attention');
      countElement.dataset.available = 'false';
    }
  }

  async function renderFailedOperations() {
    const section = document.getElementById('failedReview');
    const list = document.getElementById('failedList');
    const retryButton = document.getElementById('retryFailedChanges');
    const operationStatus = document.getElementById('failedOperationStatus');
    if (!section || !list || !window.db?.getFailedOperations) return;

    const failures = await window.db.getFailedOperations();
    list.replaceChildren();
    section.hidden = failures.length === 0;
    const canRetry = failures.some((failure) => failure.retryable);
    if (retryButton) {
      retryButton.hidden = !canRetry;
      retryButton.disabled = !navigator.onLine;
      retryButton.onclick = () => manualSync();
    }
    for (const failure of failures) {
      const item = document.createElement('li');
      const patient =
        failure.patientName || failure.patientId || 'Patient change';
      item.textContent =
        `${failure.type} · ${patient}: ${failure.lastError}` +
        (failure.retryable
          ? ' Retry is available.'
          : failure.failureCode === 'POTENTIAL_DUPLICATE'
            ? ' Review the possible matches before continuing.'
            : ' Review or restore this operation from a local offline backup.');
      if (
        failure.failureCode === 'POTENTIAL_DUPLICATE' &&
        Array.isArray(failure.duplicateMatches) &&
        failure.duplicateMatches.length
      ) {
        const matchList = document.createElement('ul');
        matchList.className = 'duplicate-review-matches';
        for (const match of failure.duplicateMatches) {
          const matchItem = document.createElement('li');
          const reasons = (match.reasons || [])
            .map((reason) =>
              reason === 'phone' ? 'phone number' : 'name and date of birth',
            )
            .join(' and ');
          matchItem.textContent =
            `${match.full_name} · ${match.id} (${reasons || 'matching details'})`;
          matchList.append(matchItem);
        }
        item.append(matchList);
        const continueButton = document.createElement('button');
        continueButton.type = 'button';
        continueButton.className = 'btn-action';
        continueButton.textContent = 'Continue as a separate patient';
        continueButton.addEventListener('click', async () => {
          if (
            !window.confirm(
              'The server will check for new matches again. Continue creating this separate patient only if these records belong to different people?',
            )
          ) return;
          continueButton.disabled = true;
          if (operationStatus) {
            operationStatus.textContent =
              'Retrying the queued patient addition after duplicate review…';
          }
          try {
            await window.db.continueFailedPatientAdd(
              failure.id,
              failure.duplicateMatches.map((match) => match.id),
            );
            const result = await window.db.syncPendingData({
              forceRetry: true,
            });
            if (operationStatus) {
              operationStatus.textContent = result.success
                ? 'The patient addition was confirmed by the server.'
                : result.partial
                  ? 'The server still requires review; the local patient and queued change were preserved.'
                  : 'The patient remains queued locally; the server has not confirmed the addition.';
            }
            await updateQueueCount();
          } catch (error) {
            if (operationStatus) {
              operationStatus.textContent =
                error?.message ||
                'The patient remains queued locally; no local patient data was removed.';
            }
          } finally {
            continueButton.disabled = false;
          }
        });
        item.append(continueButton);
      }
      if (failure.correctable && failure.failureCode !== 'POTENTIAL_DUPLICATE') {
        const correctionForm = document.createElement('form');
        correctionForm.className = 'patient-correction-form';
        const fields = [
          ['full_name', 'Full name', 'text', 255],
          ['date_of_birth', 'Date of birth', 'date'],
          ['gender', 'Gender', 'select'],
          ['phone', 'Phone', 'tel', 50],
          ['address', 'Address', 'textarea', 2000],
          ['emergency_contact_name', 'Emergency contact name', 'text', 255],
          ['emergency_contact_phone', 'Emergency contact phone', 'tel', 30],
          ['emergency_contact_relationship', 'Emergency contact relationship', 'text', 100],
          ['allergies', 'Allergies', 'textarea', 10000],
          ['medical_history', 'Medical history', 'textarea', 10000],
          ['medications', 'Medications', 'textarea', 10000],
        ];
        for (const [field, label, type, maximum] of fields) {
          const wrapper = document.createElement('label');
          wrapper.textContent = label;
          let input;
          if (type === 'select') {
            input = document.createElement('select');
            for (const [value, text] of [
              ['male', 'Male'],
              ['female', 'Female'],
              ['other', 'Other'],
            ]) {
              const option = document.createElement('option');
              option.value = value;
              option.textContent = text;
              input.append(option);
            }
          } else {
            input = document.createElement(
              type === 'textarea' ? 'textarea' : 'input',
            );
            if (type !== 'textarea') input.type = type;
            if (maximum) input.maxLength = maximum;
          }
          input.name = field;
          input.value = failure.payload?.[field] || '';
          if (
            ['full_name', 'date_of_birth', 'gender', 'phone', 'address'].includes(field)
          ) {
            input.required = true;
          }
          wrapper.append(input);
          correctionForm.append(wrapper);
        }
        const save = document.createElement('button');
        save.type = 'submit';
        save.className = 'btn-action';
        save.textContent = 'Correct and retry this operation';
        correctionForm.append(save);
        correctionForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          save.disabled = true;
          try {
            const values = Object.fromEntries(new FormData(correctionForm));
            await window.db.correctFailedOperation(failure.id, values);
            const result = await window.db.syncPendingData({
              forceRetry: true,
            });
            if (operationStatus) {
              operationStatus.textContent = result.success
                ? 'The corrected operation was confirmed by the server.'
                : result.partial
                  ? 'The corrected operation is queued or needs review; its local data was preserved.'
                  : 'The operation remains queued locally; the server has not confirmed it.';
            }
            await updateQueueCount();
          } catch (error) {
            if (operationStatus) {
              operationStatus.textContent =
                error?.message ||
                'Correction failed; the original queued data was preserved.';
            }
          } finally {
            save.disabled = false;
          }
        });
        item.append(correctionForm);
      }
      list.append(item);
    }
  }

  async function renderConflicts() {
    const section = document.getElementById('conflictReview');
    const list = document.getElementById('conflictList');
    if (!section || !list || !window.db?.getConflictedOperations) return;

    const conflicts = await window.db.getConflictedOperations();
    list.replaceChildren();
    section.hidden = conflicts.length === 0;
    for (const conflict of conflicts) {
      const card = document.createElement('article');
      card.className = 'sync-panel';
      const heading = document.createElement('h3');
      heading.textContent = `${conflict.type} · ${conflict.payload?.full_name || conflict.payload?.id || 'Patient change'}`;
      card.append(heading);

      const summary = document.createElement('p');
      summary.textContent = conflict.lastError;
      card.append(summary);

      const fields = [
        ['full_name', 'Name'],
        ['date_of_birth', 'Date of birth'],
        ['gender', 'Gender'],
        ['phone', 'Phone'],
        ['address', 'Address'],
        ['emergency_contact_name', 'Emergency contact'],
        ['emergency_contact_phone', 'Emergency phone'],
        ['emergency_contact_relationship', 'Relationship'],
        ['allergies', 'Allergies'],
        ['medical_history', 'Medical history'],
        ['medications', 'Medications'],
      ];
      const fieldChoices = {};
      const canReviewFields =
        conflict.type === 'EDIT' &&
        conflict.conflictServer &&
        !conflict.conflictServer.is_deleted;
      if (conflict.type !== 'DELETE') {
        const tableWrap = document.createElement('div');
        tableWrap.className = 'conflict-table-wrap';
        const table = document.createElement('table');
        table.className = 'conflict-comparison';
        const header = document.createElement('tr');
        for (const label of [
          'Field',
          'Original version',
          'Your queued version',
          'Current server version',
          'Resolution',
        ]) {
          const cell = document.createElement('th');
          cell.scope = 'col';
          cell.textContent = label;
          header.append(cell);
        }
        table.append(header);
        for (const [field, label] of fields) {
          const row = document.createElement('tr');
          const original = conflict.baseRecord?.[field];
          const local = conflict.payload?.[field];
          const server = conflict.conflictServer?.[field];
          const hasOriginal = typeof original === 'string';
          const localValue =
            local === undefined || local === null ? '' : String(local);
          const serverValue =
            server === undefined || server === null ? '' : String(server);
          const originalValue =
            original === undefined || original === null
              ? ''
              : String(original);
          const localChanged = !hasOriginal || localValue !== originalValue;
          const serverChanged = !hasOriginal || serverValue !== originalValue;
          const isConflict =
            localValue !== serverValue && localChanged && serverChanged;
          const statusLabel =
            localValue === serverValue
              ? 'Values match'
              : isConflict
                ? 'Choose a value'
                : localChanged
                  ? 'Local-only change; kept automatically'
                  : 'Server-only change; kept automatically';
          for (const value of [
            label,
            hasOriginal ? originalValue : 'Unavailable',
            localValue,
            serverValue,
          ]) {
            const cell = document.createElement(
              row.children.length === 0 ? 'th' : 'td',
            );
            if (row.children.length === 0) cell.scope = 'row';
            cell.textContent = value || '—';
            row.append(cell);
          }
          const resolutionCell = document.createElement('td');
          if (canReviewFields && isConflict) {
            const choice = document.createElement('select');
            choice.setAttribute(
              'aria-label',
              `Resolution for ${label.toLowerCase()}`,
            );
            const prompt = document.createElement('option');
            prompt.value = '';
            prompt.textContent = 'Choose…';
            choice.append(prompt);
            for (const [value, text] of [
              ['server', 'Use server value'],
              ['local', 'Use my value'],
            ]) {
              const option = document.createElement('option');
              option.value = value;
              option.textContent = text;
              choice.append(option);
            }
            choice.addEventListener('change', () => {
              if (choice.value) fieldChoices[field] = choice.value;
              else delete fieldChoices[field];
            });
            resolutionCell.append(choice);
          } else {
            resolutionCell.textContent = statusLabel;
          }
          row.append(resolutionCell);
          table.append(row);
        }
        tableWrap.append(table);
        card.append(tableWrap);
        if (
          !conflict.baseRecord ||
          fields.some(
            ([field]) =>
              typeof conflict.baseRecord[field] !== 'string',
          )
        ) {
          const baselineNotice = document.createElement('p');
          baselineNotice.textContent =
            'Some original values are unavailable. Any differing field without a known original requires an explicit choice.';
          card.append(baselineNotice);
        }
      }

      const actions = document.createElement('div');
      actions.className = 'sync-panel-heading';
      const useServer = document.createElement('button');
      useServer.type = 'button';
      useServer.className = 'btn-action';
      useServer.textContent = 'Use server version';
      useServer.addEventListener('click', () =>
        resolvePatientConflict(conflict.id, 'server'),
      );
      actions.append(useServer);
      if (conflict.type !== 'ADD') {
        const keepLocal = document.createElement('button');
        keepLocal.type = 'button';
        keepLocal.className = 'btn-primary';
        keepLocal.textContent =
          conflict.type === 'DELETE'
            ? 'Keep queued deletion'
            : 'Keep all my queued values';
        keepLocal.disabled =
          !conflict.conflictServer ||
          Boolean(conflict.conflictServer.is_deleted);
        keepLocal.title = keepLocal.disabled
          ? 'The server record is unavailable or deleted, so this change cannot be rebased.'
          : 'Re-submit every queued value against the current server version.';
        keepLocal.addEventListener('click', () =>
          resolvePatientConflict(conflict.id, 'local'),
        );
        actions.append(keepLocal);
      }
      if (canReviewFields) {
        const applyChoices = document.createElement('button');
        applyChoices.type = 'button';
        applyChoices.className = 'btn-primary';
        applyChoices.textContent = 'Apply field choices';
        applyChoices.addEventListener('click', () =>
          resolvePatientConflict(conflict.id, { fields: fieldChoices }),
        );
        actions.append(applyChoices);
      }
      card.append(actions);
      list.append(card);
    }
  }

  async function resolvePatientConflict(id, choice) {
    const status = document.getElementById('conflictResolutionStatus');
    try {
      const result = await window.db.resolveConflict(id, choice);
      if (status)
        status.textContent =
          result.choice === 'server'
            ? 'The server version was selected; the conflicting queued change was resolved.'
            : result.choice === 'fields'
              ? 'Your field choices and non-conflicting local changes were saved as a new queued operation based on the latest server version.'
              : 'Your queued values were preserved as a new operation based on the latest server version.';
      await updateQueueCount();
      window.dispatchEvent(new CustomEvent('healthsys:records-changed'));
    } catch (error) {
      if (status)
        status.textContent =
          error?.message ||
          'The conflict could not be resolved. Both versions remain stored.';
    }
  }

  function updateConnectionStatus() {
    const banner = document.getElementById('offlineBanner');
    if (banner) banner.style.display = navigator.onLine ? 'none' : 'block';
  }

  async function saveMetrics(metrics) {
    try {
      const cachedMetrics = { ...metrics };
      delete cachedMetrics.recentActivity;
      delete cachedMetrics.recentPatients;
      await window.db.saveDashboardMetrics(cachedMetrics);
    } catch (error) {
      console.error(
        '[DASHBOARD] Could not cache dashboard metrics in IndexedDB:',
        error,
      );
    }
  }

  async function readCachedMetrics() {
    try {
      return await window.db.getDashboardMetrics();
    } catch (error) {
      console.error(
        '[DASHBOARD] Could not read cached dashboard metrics from IndexedDB:',
        error,
      );
      return null;
    }
  }

  function displayMetrics(metrics, source, savedAt = null) {
    document.body.dataset.metricsReady = 'true';
    if (source === 'server' && metrics.serverSnapshotAt) {
      document.body.dataset.serverSnapshotAt = metrics.serverSnapshotAt;
    }
    const error = document.getElementById('metricsError');
    if (error) error.hidden = true;
    setText('patientTotal', String(metrics.patients.total));
    setText('patientActive', String(metrics.patients.active));
    setText(
      'patientDeleted',
      metrics.patients.deleted === null
        ? 'Unavailable'
        : String(metrics.patients.deleted),
    );
    setText('patientActiveDetail', 'Active records · not soft-deleted');
    setText(
      'patientDeletedDetail',
      metrics.patients.deleted === null
        ? 'Deleted records are not available in the local database.'
        : 'Soft-deleted records',
    );

    const staffCards = document.querySelectorAll('[data-staff-metric]');
    if (
      metrics.staff &&
      metrics.staff.total !== undefined &&
      document.body.dataset.userRole === 'admin'
    ) {
      setText('staffTotal', String(metrics.staff.total));
      setText('staffActive', String(metrics.staff.active));
      setText('staffInactive', String(metrics.staff.inactive));
      staffCards.forEach((card) => {
        card.hidden = false;
      });
    } else {
      staffCards.forEach((card) => {
        card.hidden = true;
      });
    }

    const sourceText =
      source === 'server'
        ? 'Counts from the server database.'
        : `Counts from this device${savedAt ? ` (last server snapshot ${formatTimestamp(savedAt)})` : ''}; they may differ from the server.`;
    setText('metricsSource', sourceText);
    if (source === 'server') {
      renderRecentActivity(metrics);
    }
    const snapshotAt = document.body.dataset.serverSnapshotAt;
    const recentSource = source === 'server'
      ? `Server snapshot${metrics.serverSnapshotAt ? ` · ${formatTimestamp(metrics.serverSnapshotAt)}` : ''}.`
      : snapshotAt
        ? `Last server-rendered snapshot · ${formatTimestamp(snapshotAt)}. Not refreshed while offline.`
        : 'No server snapshot is available for recent activity.';
    setText('recentPatientsSource', recentSource);
    setText('recentActivitySource', recentSource);
  }

  function activityTitle(action) {
    return ({
      'patient.create': 'Patient record created',
      'patient.update': 'Patient record updated',
      'patient.delete': 'Patient record archived',
      'patient.restore': 'Patient record restored',
      'patient.visit.create': 'Patient visit recorded',
      'patient.import.csv': 'Patient CSV import',
      'patient.export.csv': 'Patient CSV export',
      'patient.sync': 'Patient synchronization',
      'patient.sync.conflict': 'Synchronization conflict',
      'staff.create': 'Staff account created',
      'staff.enable': 'Staff account enabled',
      'staff.disable': 'Staff account disabled',
      'staff.role_change': 'Staff role changed',
      'staff.password_reset': 'Staff password reset',
      'backup.server.create': 'Server backup created',
      'backup.server.restore': 'Server backup restored',
    })[action] || 'Administrative activity';
  }

  function renderRecentActivity(metrics) {
    const patientList = document.getElementById('recentPatientsList');
    const patientEmpty = document.getElementById('recentPatientsEmpty');
    if (patientList && Array.isArray(metrics.recentPatients)) {
      patientList.replaceChildren();
      for (const patient of metrics.recentPatients) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `/patients/${encodeURIComponent(patient.id)}`;
        const name = document.createElement('span');
        name.textContent = patient.full_name;
        const id = document.createElement('small');
        id.textContent = patient.id;
        link.append(name, id);
        const created = document.createElement('time');
        const date = new Date(patient.created_at);
        created.dateTime = Number.isNaN(date.getTime()) ? '' : date.toISOString();
        created.textContent = formatTimestamp(patient.created_at);
        item.append(link, created);
        patientList.append(item);
      }
      patientList.hidden = metrics.recentPatients.length === 0;
      if (patientEmpty) {
        patientEmpty.hidden = metrics.recentPatients.length > 0;
        patientEmpty.textContent = 'No active patient records are available.';
      }
    } else if (patientList) {
      patientList.replaceChildren();
      patientList.hidden = true;
      if (patientEmpty) {
        patientEmpty.hidden = false;
        patientEmpty.textContent = 'Recent patient registrations are unavailable.';
      }
    }

    const activityList = document.getElementById('recentActivityList');
    const activityEmpty = document.getElementById('recentActivityEmpty');
    if (activityList && Array.isArray(metrics.recentActivity)) {
      activityList.replaceChildren();
      for (const event of metrics.recentActivity) {
        const item = document.createElement('li');
        const description = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = activityTitle(event.action);
        const actor = document.createElement('small');
        actor.textContent = `${event.actor_name || 'System'}${event.actor_role ? ` (${event.actor_role})` : ''} · ${event.outcome || 'unknown outcome'}`;
        description.append(title, actor);
        const timestamp = document.createElement('time');
        const date = new Date(event.created_at);
        timestamp.dateTime = Number.isNaN(date.getTime()) ? '' : date.toISOString();
        timestamp.textContent = formatTimestamp(event.created_at);
        item.append(description, timestamp);
        activityList.append(item);
      }
      activityList.hidden = metrics.recentActivity.length === 0;
      if (activityEmpty) {
        activityEmpty.hidden = metrics.recentActivity.length > 0;
        activityEmpty.textContent = 'No recent activity is available.';
      }
    } else if (activityList) {
      activityList.replaceChildren();
      activityList.hidden = true;
      if (activityEmpty) {
        activityEmpty.hidden = false;
        activityEmpty.textContent = 'Recent activity is unavailable.';
      }
    }
  }

  async function refreshDashboardMetrics() {
    const state = document.getElementById('metricsSource');
    if (state && document.body.dataset.metricsReady !== 'true') {
      state.textContent = 'Loading dashboard metrics...';
    }

    if (navigator.onLine) {
      try {
        const response = await fetch('/dashboard/metrics', {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const metrics = await response.json();
        if (
          !metrics.patients ||
          !Number.isFinite(Number(metrics.patients.total))
        ) {
          throw new Error('The server returned invalid dashboard metrics.');
        }
        await saveMetrics(metrics);
        displayMetrics(metrics, 'server');
        return;
      } catch (error) {
        console.warn(
          '[DASHBOARD] Server metrics unavailable; trying local data.',
          error,
        );
      }
    }

    try {
      if (!window.db || !window.db.getPatients)
        throw new Error('Local patient database is unavailable.');
      const patients = await window.db.getPatients();
      const cached = await readCachedMetrics();
      displayMetrics(
        {
          patients: {
            total: patients.length,
            active: patients.length,
            deleted: null,
          },
          staff: cached?.metrics?.staff || null,
        },
        'local',
        cached?.savedAt,
      );
    } catch (error) {
      console.error('[DASHBOARD] Local metrics unavailable:', error);
      if (state)
        state.textContent =
          'Patient counts are unavailable; no server or local database could be read.';
      const errorElement = document.getElementById('metricsError');
      if (errorElement) {
        errorElement.textContent =
          'Dashboard metrics could not be loaded. Reconnect or retry.';
        errorElement.hidden = false;
      }
      setText('patientTotal', 'Unavailable');
      setText('patientActive', 'Unavailable');
      setText('patientDeleted', 'Unavailable');
    }
  }

  function syncProgress(event) {
    const { completed, total } = event.detail || {};
    const progress = document.getElementById('syncProgress');
    if (!progress) return;
    if (Number.isInteger(total) && total > 0 && Number.isInteger(completed)) {
      progress.textContent = `Server processing ${total} queued operation(s); ${completed} confirmed so far.`;
    } else {
      progress.textContent = 'Synchronization is in progress...';
    }
  }

  async function manualSync() {
    if (activeSync) return activeSync;
    const button = document.getElementById('syncButton');
    if (!window.db || typeof window.db.syncPendingData !== 'function') {
      setSyncOutcome(
        'Failure',
        'The local synchronization service is unavailable.',
      );
      return;
    }

    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    }
    const progress = document.getElementById('syncProgress');
    if (progress) progress.textContent = 'Starting synchronization...';

    activeSync = (async () => {
      try {
        const result = await window.db.syncPendingData({ forceRetry: true });
        if (result.success) {
          setSyncOutcome(
            'Success',
            result.nothingToSync
              ? 'No pending changes; the server was not contacted.'
              : `${result.processed} operation(s) confirmed by the server.`,
          );
          if (progress)
            progress.textContent = result.nothingToSync
              ? 'Nothing to synchronize.'
              : `${result.processed} of ${result.processed} queued operation(s) confirmed.`;
          await refreshDashboardMetrics();
          if (typeof window.refreshPatients === 'function') {
            try {
              await window.refreshPatients();
            } catch (error) {
              console.error(
                '[DASHBOARD] Patient list refresh after sync failed:',
                error,
              );
            }
          }
          window.dispatchEvent(new CustomEvent('healthsys:records-changed'));
        } else if (result.partial) {
          setSyncOutcome(
            'Partial Failure',
            result.error ||
              'Some operations remain queued for retry or review.',
          );
          if (progress)
            progress.textContent = `${result.processed} operation(s) confirmed; ${result.unresolved} remain queued.`;
        } else {
          setSyncOutcome(
            'Failure',
            result.error ||
              'Synchronization failed. Queued changes were retained.',
          );
          if (progress)
            progress.textContent = result.error || 'Synchronization failed.';
        }
        return result;
      } catch (error) {
        console.error('[DASHBOARD] Sync failed:', error);
        setSyncOutcome(
          'Failure',
          error.message ||
            'Synchronization failed. Queued changes were retained.',
        );
        if (progress)
          progress.textContent = error.message || 'Synchronization failed.';
        return { success: false, error: error.message };
      } finally {
        await updateQueueCount();
        renderSyncMetadata(
          window.db.getSyncMetadata ? window.db.getSyncMetadata() : {},
        );
        if (button) {
          button.disabled = false;
          button.removeAttribute('aria-busy');
        }
        activeSync = null;
      }
    })();
    return activeSync;
  }

  window.manualSync = manualSync;
  window.refreshDashboardMetrics = refreshDashboardMetrics;
  window.notifyRecordChange = () => {
    if (recordsChannel) recordsChannel.postMessage('changed');
    refreshDashboardMetrics();
  };

  window.addEventListener('healthsys:sync-state', (event) => {
    renderSyncMetadata(event.detail);
  });
  window.addEventListener('healthsys:sync-progress', syncProgress);
  window.addEventListener('healthsys:queue-changed', updateQueueCount);
  window.addEventListener('healthsys:queue-changed', async () => {
    await Promise.all([updateQueueCount(), refreshDashboardMetrics()]);
  });
  window.addEventListener('healthsys:records-changed', refreshDashboardMetrics);
  window.addEventListener('healthsys:automatic-sync', async (event) => {
    const result = event.detail || {};
    if (result.success) {
      await refreshDashboardMetrics();
      if (typeof window.refreshPatients === 'function')
        await window.refreshPatients();
    }
    await updateQueueCount();
  });
  window.addEventListener('online', async () => {
    updateConnectionStatus();
    await refreshDashboardMetrics();
    if (!window.db || !window.db.syncQueue) return;
    try {
      if (await window.db.syncQueue.count()) {
        const result = await window.db.syncPendingData();
        window.dispatchEvent(
          new CustomEvent('healthsys:automatic-sync', { detail: result }),
        );
      }
    } catch (error) {
      console.error('[DASHBOARD] Automatic synchronization failed:', error);
    }
  });
  window.addEventListener('offline', () => {
    updateConnectionStatus();
    refreshDashboardMetrics();
  });
  window.addEventListener('focus', async () => {
    await Promise.all([updateQueueCount(), refreshDashboardMetrics()]);
  });
  if (recordsChannel) {
    recordsChannel.addEventListener('message', () => {
      refreshDashboardMetrics();
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    let localStorageReady = false;
    try {
      localStorageReady = window.db
        ? await window.db.databaseReady?.() !== false
        : false;
      if (localStorageReady && window.db.setCurrentUser) {
        await window.db.setCurrentUser(document.body.dataset.userId || '');
      } else if (window.db && localStorageReady) {
        window.db.userId = document.body.dataset.userId || '';
      }
      if (localStorageReady && window.db?.recoverInterruptedSync)
        await window.db.recoverInterruptedSync();
    } catch (error) {
      localStorageReady = false;
      console.error(
        '[DASHBOARD] Local patient storage initialization failed:',
        error?.name || 'DATABASE_ERROR',
      );
    }
    if (!localStorageReady) {
      setText(
        'queueCount',
        'Unavailable',
      );
      setText(
        'queueDetails',
        'Local synchronization is unavailable; server dashboard data can still be used.',
      );
    }
    updateConnectionStatus();
    renderSyncMetadata(
      window.db?.getSyncMetadata ? window.db.getSyncMetadata() : {},
    );
    await Promise.all([updateQueueCount(), refreshDashboardMetrics()]);
    let queue = null;
    if (localStorageReady) {
      try {
        queue = await window.db.getQueueStatus();
      } catch (error) {
        console.error(
          '[DASHBOARD] Could not read pending queue after initialization:',
          error?.name || 'DATABASE_ERROR',
        );
      }
    }
    if (navigator.onLine && queue?.pending > 0) {
      const result = await window.db.syncPendingData();
      window.dispatchEvent(
        new CustomEvent('healthsys:automatic-sync', { detail: result }),
      );
    }
  });
})();
