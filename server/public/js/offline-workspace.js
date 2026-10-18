(function () {
  const workspace = document.getElementById('offlineWorkspace');
  const boot = document.getElementById('offlineBoot');
  const locked = document.getElementById('offlineLocked');
  const lockedMessage = document.getElementById('offlineLockedMessage');
  const content = document.getElementById('offlinePatientContent');
  const connection = document.getElementById('offlineConnection');
  const account = document.getElementById('offlineAccount');
  const signIn = document.getElementById('offlineSignIn');
  const actionStatus = document.getElementById('offlineActionStatus');
  const rowContainer = document.getElementById('offlinePatientRows');
  const emptyState = document.getElementById('offlineEmptyState');
  const queueStatus = document.getElementById('offlineQueueStatus');
  const addForm = document.getElementById('offlinePatientForm');
  const editDialog = document.getElementById('offlineEditDialog');
  const editForm = document.getElementById('offlineEditForm');
  const syncButton = document.getElementById('syncOfflineChanges');
  const addSaveButton = addForm.querySelector('[type="submit"]');
  const OPERATION_FIELDS = [
    ['full_name', 'Patient name', 'text', true],
    ['date_of_birth', 'Date of birth', 'date', true],
    ['gender', 'Gender', 'select', true],
    ['phone', 'Phone', 'tel', true],
    ['address', 'Address', 'text', true],
    ['emergency_contact_name', 'Emergency contact name', 'text', false],
    ['emergency_contact_phone', 'Emergency contact phone', 'tel', false],
    [
      'emergency_contact_relationship',
      'Emergency contact relationship',
      'text',
      false,
    ],
    ['allergies', 'Allergies', 'textarea', false],
    ['medical_history', 'Medical history', 'textarea', false],
    ['medications', 'Medications', 'textarea', false],
  ];
  const FIELD_LIMITS = {
    full_name: 255,
    address: 2000,
    emergency_contact_name: 255,
    emergency_contact_phone: 30,
    emergency_contact_relationship: 100,
    allergies: 10000,
    medical_history: 10000,
    medications: 10000,
  };
  const FIELD_SECTIONS = [
    {
      title: 'Personal information',
      fields: ['full_name', 'date_of_birth', 'gender', 'phone', 'address'],
    },
    {
      title: 'Emergency contact',
      fields: [
        'emergency_contact_name',
        'emergency_contact_phone',
        'emergency_contact_relationship',
      ],
    },
    {
      title: 'Medical information',
      fields: ['allergies', 'medical_history', 'medications'],
    },
  ];
  const WIDE_FIELDS = new Set([
    'address',
    'emergency_contact_relationship',
    'allergies',
    'medical_history',
    'medications',
  ]);
  const FIELDS_BY_NAME = new Map(
    OPERATION_FIELDS.map((field) => [field[0], field]),
  );
  let activeContext = null;
  let serverAuthenticated = false;
  let patients = [];
  let editingPatient = null;

  function setMessage(message, isError = false) {
    actionStatus.textContent = message || '';
    actionStatus.classList.toggle('is-error', isError);
  }

  function showLocked(message, allowSignIn = true) {
    activeContext = null;
    serverAuthenticated = false;
    content.hidden = true;
    locked.hidden = false;
    signIn.hidden = !allowSignIn;
    document.getElementById('lockOfflineWorkspace').hidden = true;
    document.querySelectorAll('[data-admin-link]').forEach((link) => {
      link.hidden = true;
    });
    lockedMessage.textContent = message;
    connection.textContent = navigator.onLine
      ? 'Offline access not established'
      : 'Device offline';
    syncButton.disabled = true;
  }

  function showUnavailable(message) {
    connection.textContent = message;
    signIn.hidden = Boolean(activeContext);
  }

  function makeField(fieldSet, patient = {}) {
    const [name, labelText, type, required] = fieldSet;
    const label = document.createElement('label');
    label.className = 'offline-field';
    const caption = document.createElement('span');
    caption.textContent = labelText;
    let input;
    if (type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 4;
    } else if (type === 'select') {
      input = document.createElement('select');
      for (const [value, text] of [
        ['', 'Select gender'],
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
      input = document.createElement('input');
      input.type = type;
    }
    input.name = name;
    input.value = typeof patient[name] === 'string' ? patient[name] : '';
    input.required = required;
    if (name === 'date_of_birth') {
      input.max = new Date().toISOString().slice(0, 10);
    }
    if (FIELD_LIMITS[name]) input.maxLength = FIELD_LIMITS[name];
    if (name.endsWith('_phone') || name === 'phone') {
      input.maxLength = 40;
      input.autocomplete = 'tel';
    }
    label.append(caption, input);
    return label;
  }

  function populateForm(target, patient = {}) {
    const sections = FIELD_SECTIONS.map(({ title, fields }) => {
      const section = document.createElement('section');
      section.className = 'offline-form-section';
      const heading = document.createElement('h3');
      heading.textContent = title;
      const grid = document.createElement('div');
      grid.className = 'offline-form-grid';
      const controls = fields.map((name) => {
        const field = makeField(FIELDS_BY_NAME.get(name), patient);
        if (WIDE_FIELDS.has(name)) field.classList.add('offline-field-wide');
        return field;
      });
      grid.append(...controls);
      section.append(heading, grid);
      return section;
    });
    target.replaceChildren(...sections);
  }

  function readForm(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    for (const [key, value] of Object.entries(values)) {
      values[key] = String(value).trim();
    }
    const normalizePhone = (value) => {
      if (!/^\+?[0-9().\-\s]+$/.test(value || '')) return null;
      let normalized = value.replace(/[().\-\s]/g, '');
      if (normalized.startsWith('00')) normalized = `+${normalized.slice(2)}`;
      const digits = normalized.startsWith('+')
        ? normalized.slice(1)
        : normalized;
      return /^\d{7,15}$/.test(digits) ? normalized : null;
    };
    values.phone = normalizePhone(values.phone);
    if (!values.phone) {
      throw new Error('Enter a valid patient phone number.');
    }
    if (values.emergency_contact_phone) {
      values.emergency_contact_phone = normalizePhone(
        values.emergency_contact_phone,
      );
      if (!values.emergency_contact_phone) {
        throw new Error('Enter a valid emergency contact phone number.');
      }
    }
    for (const [field, maximum] of Object.entries(FIELD_LIMITS)) {
      if (values[field].length > maximum) {
        throw new Error(
          `Patient field ${field.replaceAll('_', ' ')} exceeds ${maximum} characters.`,
        );
      }
    }
    return values;
  }

  async function openWorkspace(context) {
    if (!context || !window.HealthSysOfflineAccess?.read()) {
      showLocked(
        'Sign in while connected to establish offline access for this account.',
      );
      return false;
    }
    if (!(await window.healthsysDBReady)) {
      showLocked(
        window.healthsysDBError ||
          'Local patient storage could not be opened. Do not clear browser data or reinstall the app.',
      );
      return false;
    }
    window.db.setOfflineUser(context.userId);
    activeContext = context;
    document.getElementById('lockOfflineWorkspace').hidden = false;
    account.textContent = `${context.username || 'Previously signed-in account'} · local data is not guaranteed to be current`;
    document.querySelectorAll('[data-admin-link]').forEach((link) => {
      link.hidden = context.role !== 'admin';
    });
    document.getElementById('showAddPatient').hidden = ![
      'admin',
      'staff',
    ].includes(context.role);
    document.getElementById('offlineBoot').hidden = true;
    workspace.hidden = false;
    locked.hidden = true;
    content.hidden = false;
    await renderPatients();
    return true;
  }

  function localStatus(patient) {
    if (patient.pendingSyncDelete) return 'Deletion queued · not confirmed';
    if (patient.pendingSync) return 'Change queued · not confirmed';
    if (patient.is_deleted) return 'Deleted on server';
    return 'Stored locally';
  }

  function patientRow(patient) {
    const row = document.createElement('tr');
    const patientCell = document.createElement('td');
    const name = document.createElement('strong');
    name.textContent = patient.full_name || 'Unnamed patient';
    const identifier = document.createElement('small');
    identifier.textContent = patient.id;
    const missingFields = [
      ['full_name', 'Name'],
      ['date_of_birth', 'Date of birth'],
      ['gender', 'Gender'],
      ['phone', 'Phone'],
      ['address', 'Address'],
    ]
      .filter(([field]) => !String(patient[field] || '').trim())
      .map(([, label]) => label);
    patientCell.append(name, identifier);
    if (missingFields.length) {
      const warning = document.createElement('small');
      warning.className = 'offline-completeness-warning';
      warning.textContent = `Incomplete record · required fields missing: ${missingFields.join(', ')}`;
      patientCell.append(warning);
    }
    row.append(patientCell);
    for (const value of [patient.date_of_birth || '—', patient.phone || '—']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    const statusCell = document.createElement('td');
    statusCell.textContent = localStatus(patient);
    row.append(statusCell);

    const actionCell = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'offline-row-actions';
    if (
      ['admin', 'staff'].includes(activeContext.role) &&
      !patient.is_deleted
    ) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn-action';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => showEditForm(patient));
      actions.append(edit);
    }
    if (activeContext.role === 'admin' && !patient.is_deleted) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-danger offline-delete';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => deletePatient(patient));
      actions.append(remove);
    }
    actionCell.append(actions);
    row.append(actionCell);
    return row;
  }

  async function renderPatients() {
    if (!activeContext || !window.HealthSysOfflineAccess?.read()) {
      showLocked(
        'Offline access expired. Reconnect and sign in to establish it again.',
      );
      return;
    }
    const search = document
      .getElementById('offlineSearch')
      .value.trim()
      .toLocaleLowerCase();
    patients = await window.db.getPatients();
    const visible = patients
      .filter((patient) =>
        [patient.full_name, patient.id, patient.phone].some((value) =>
          String(value || '')
            .toLocaleLowerCase()
            .includes(search),
        ),
      )
      .sort((left, right) =>
        String(left.full_name || '').localeCompare(
          String(right.full_name || ''),
        ),
      );
    rowContainer.replaceChildren(...visible.map(patientRow));
    emptyState.hidden = visible.length > 0;
    const status = await window.db.getQueueStatus();
    queueStatus.textContent =
      `${patients.length} local record(s) · ${status.pending} pending · ` +
      `${status.processing} processing · ${status.failed} failed · ${status.conflicts} conflicts`;
    syncButton.disabled =
      !serverAuthenticated || !navigator.onLine || status.total === 0;
  }

  async function refreshFromServer() {
    const response = await fetch('/patients/json', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok)
      throw new Error(`Patient refresh failed with HTTP ${response.status}.`);
    const records = await response.json();
    if (!Array.isArray(records))
      throw new Error('The server returned an invalid patient list.');
    await window.db.savePatients(records);
  }

  async function synchronize() {
    if (!serverAuthenticated || !navigator.onLine || !activeContext) return;
    syncButton.disabled = true;
    setMessage('Sending queued changes to HealthSys…');
    try {
      const result = await window.db.syncPendingData();
      if (result.success || result.processed > 0) await refreshFromServer();
      setMessage(
        result.success
          ? 'Synchronization confirmed by HealthSys.'
          : result.error || 'Some changes remain queued for review.',
        !result.success,
      );
    } catch (error) {
      setMessage(
        `Synchronization did not complete. Queued changes were retained. ${error.message || ''}`,
        true,
      );
    } finally {
      await renderPatients();
    }
  }

  async function verifyServerSession() {
    if (!navigator.onLine) {
      serverAuthenticated = false;
      showUnavailable(
        'Offline · using the previously authorized local workspace',
      );
      await renderPatients();
      return false;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch('/session/status', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.status === 401) {
        window.HealthSysOfflineAccess.clear();
        serverAuthenticated = false;
        showLocked(
          'HealthSys says this session has expired or been revoked. Sign in again before opening local patient records.',
        );
        return false;
      }
      if (!response.ok) {
        serverAuthenticated = false;
        showUnavailable(
          `HealthSys is temporarily unavailable (HTTP ${response.status}); local records remain available.`,
        );
        await renderPatients();
        return false;
      }
      const result = await response.json();
      if (result?.authenticated !== true || !result.user?.id) {
        window.HealthSysOfflineAccess.clear();
        showLocked(
          'HealthSys could not validate this sign-in. Sign in again before opening local patient records.',
        );
        return false;
      }
      activeContext = window.HealthSysOfflineAccess.save(result.user);
      window.db.setOfflineUser(activeContext.userId);
      if (result.csrfToken) document.body.dataset.csrfToken = result.csrfToken;
      serverAuthenticated = true;
      showUnavailable(
        'Connected · session verified; local changes may now synchronize',
      );
      await openWorkspace(activeContext);
      await renderPatients();
      const queue = await window.db.getQueueStatus();
      syncButton.disabled = queue.total === 0;
      if (queue.pending > 0) await synchronize();
      return true;
    } catch (error) {
      serverAuthenticated = false;
      const message =
        error?.name === 'AbortError'
          ? 'Server check timed out · local records remain available'
          : 'Server unreachable · local records remain available';
      showUnavailable(message);
      await renderPatients();
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function showEditForm(patient) {
    if (!activeContext || !['admin', 'staff'].includes(activeContext.role))
      return;
    editingPatient = patient;
    populateForm(document.getElementById('offlineEditFields'), patient);
    editDialog.showModal();
  }

  async function deletePatient(patient) {
    if (activeContext?.role !== 'admin') return;
    if (
      !window.confirm(
        `Queue a deletion for ${patient.full_name || 'this patient'}? The server record will not be deleted until synchronization is confirmed.`,
      )
    )
      return;
    try {
      await window.db.queuePatientDeletion(
        patient.id,
        Number(patient.version),
        crypto.randomUUID(),
      );
      setMessage(
        'Deletion saved locally and queued. The server record is unchanged until synchronization is confirmed.',
      );
      await renderPatients();
    } catch (error) {
      setMessage(
        error.message || 'The deletion could not be saved locally.',
        true,
      );
    }
  }

  document.getElementById('showAddPatient').addEventListener('click', () => {
    document.getElementById('offlineFormHeading').textContent = 'Add Patient';
    populateForm(document.getElementById('offlineFormFields'));
    addForm.hidden = false;
    document
      .getElementById('offlinePatientForm')
      .elements.namedItem('full_name')
      .focus();
  });
  document.getElementById('cancelOfflineForm').addEventListener('click', () => {
    addForm.reset();
    addForm.hidden = true;
    setMessage('');
  });
  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!activeContext || !['admin', 'staff'].includes(activeContext.role))
      return;
    if (addForm.dataset.saving === 'true') return;
    if (!addForm.reportValidity()) return;
    try {
      const data = readForm(addForm);
      const existingPatients = await window.db.getPatients();
      const localMatches = existingPatients.filter((candidate) =>
        !candidate.is_deleted &&
        (String(candidate.phone || '').trim() === data.phone ||
          (String(candidate.full_name || '').trim().toLocaleLowerCase() ===
            data.full_name.toLocaleLowerCase() &&
            String(candidate.date_of_birth || '').slice(0, 10) ===
              data.date_of_birth)),
      );
      if (
        localMatches.length &&
        !window.confirm(
          `Local-only duplicate check found ${localMatches.length} possible match(es):\n` +
            localMatches
              .slice(0, 5)
              .map((match) => `${match.full_name} · ${match.id}`)
              .join('\n') +
            '\n\nThese records are only those stored on this device. HealthSys will check again when synchronizing. Save a separate record anyway?',
        )
      ) {
        setMessage('Patient was not added. No local record was changed.');
        return;
      }
      const now = new Date().toISOString();
      const patient = {
        ...data,
        id: crypto.randomUUID(),
        version: 1,
        is_deleted: false,
        pendingSync: true,
        created_at: now,
        updated_at: now,
      };
      addForm.dataset.saving = 'true';
      addForm.setAttribute('aria-busy', 'true');
      addSaveButton.disabled = true;
      addSaveButton.textContent = 'Saving locally…';
      await window.db.addLocalPatientAndQueue(patient, crypto.randomUUID());
      addForm.reset();
      addForm.hidden = true;
      setMessage(
        'Patient saved on this device and queued. The server has not confirmed the record yet.',
      );
      await renderPatients();
    } catch (error) {
      setMessage(error.message || 'Patient could not be saved locally.', true);
    } finally {
      delete addForm.dataset.saving;
      addForm.removeAttribute('aria-busy');
      addSaveButton.disabled = false;
      addSaveButton.textContent = 'Save on this device';
    }
  });
  editForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!editingPatient || !editForm.reportValidity()) return;
    try {
      const updated = { ...editingPatient, ...readForm(editForm) };
      await window.db.updateLocalPatientAndQueue(
        updated,
        Number(editingPatient.version),
      );
      editDialog.close();
      editingPatient = null;
      setMessage(
        'Edit saved on this device and queued. The server has not confirmed it yet.',
      );
      await renderPatients();
    } catch (error) {
      setMessage(error.message || 'The edit could not be saved locally.', true);
    }
  });
  document.getElementById('cancelOfflineEdit').addEventListener('click', () => {
    editDialog.close();
    editingPatient = null;
  });
  document.getElementById('offlineSearch').addEventListener('input', () => {
    void renderPatients();
  });
  syncButton.addEventListener('click', () => void synchronize());
  document
    .getElementById('lockOfflineWorkspace')
    .addEventListener('click', () => {
      window.HealthSysOfflineAccess.clear();
      document.querySelectorAll('[data-admin-link]').forEach((link) => {
        link.hidden = true;
      });
      account.textContent = '';
      showLocked(
        'Offline access is locked. Patient records and queued changes remain stored on this device and were not removed.',
      );
    });
  document
    .getElementById('retryOfflineConnection')
    .addEventListener('click', () => {
      void verifyServerSession();
    });

  async function initialize() {
    try {
      const ready = await window.healthsysDBReady;
      if (!ready) {
        showLocked(
          window.healthsysDBError ||
            'Local patient storage could not be opened. Do not clear browser data or reinstall the app.',
        );
        return;
      }
      const context = window.HealthSysOfflineAccess.read();
      if (context) {
        await openWorkspace(context);
        connection.textContent = navigator.onLine
          ? 'Checking server · local records remain available'
          : 'Offline · local changes are available';
      } else {
        showLocked(
          'Sign in while connected to establish offline access for this account.',
        );
        document.getElementById('offlineBoot').hidden = true;
        workspace.hidden = false;
      }
      if (navigator.onLine) await verifyServerSession();
    } catch (error) {
      console.error(
        '[OFFLINE WORKSPACE] Initialization failed:',
        error?.name || error,
      );
      showLocked(
        'The offline workspace could not be opened. Local records and queued operations were not cleared.',
      );
    } finally {
      boot.hidden = true;
    }
  }

  window.addEventListener('online', () => void verifyServerSession());
  window.addEventListener('offline', () => {
    serverAuthenticated = false;
    showUnavailable(
      'Offline · using the previously authorized local workspace',
    );
    void renderPatients();
  });
  window.addEventListener(
    'healthsys:queue-changed',
    () => void renderPatients(),
  );
  void initialize();
})();
