(function () {
  const UPDATE_NOTICE_ID = 'healthsys-sw-update';
  const INSTALL_PROMPT_DISMISSED_KEY = 'healthsys-install-prompt-dismissed';
  let registration = null;
  let activationRequested = false;
  let updateAvailable = false;
  let hadController = false;
  let deferredInstallPrompt = null;
  let installNotice = null;
  let installPromptDismissed = false;

  try {
    installPromptDismissed =
      window.sessionStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY) === 'true';
  } catch (error) {
    developmentLog(
      'Could not read install prompt dismissal state.',
      error?.name || 'SESSION_STORAGE_ERROR',
    );
  }

  function dismissInstallPromptForSession() {
    installPromptDismissed = true;
    try {
      window.sessionStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, 'true');
    } catch (error) {
      developmentLog(
        'Could not persist install prompt dismissal state.',
        error?.name || 'SESSION_STORAGE_ERROR',
      );
    }
    installNotice?.remove();
    installNotice = null;
  }

  function developmentLog(message, details = '') {
    if (
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1'
    ) {
      console.info(`[PWA] ${message}`, details);
    }
  }

  function queueCount() {
    return (
      window.db
        ?.getQueueStatus?.()
        .then((status) => status.total + status.reviewRequired)
        .catch(() => null) || Promise.resolve(null)
    );
  }

  async function requestUpdateActivation(worker) {
    if (!worker || activationRequested) return false;
    activationRequested = true;
    if (window.db?.isBusy?.()) {
      activationRequested = false;
      showUpdateNotice();
      return false;
    }
    try {
      worker.postMessage({ type: 'ACTIVATE_UPDATE' });
      return true;
    } catch (error) {
      activationRequested = false;
      developmentLog(
        'Could not request worker activation.',
        error?.name || 'ACTIVATION_ERROR',
      );
      return false;
    }
  }

  function showUpdateNotice() {
    if (!updateAvailable || document.getElementById(UPDATE_NOTICE_ID)) return;
    const notice = document.createElement('section');
    notice.id = UPDATE_NOTICE_ID;
    notice.className = 'notice notice-warn';
    notice.setAttribute('role', 'status');

    const message = document.createElement('p');
    message.textContent =
      'A HealthSys update is ready. It preserves patient records and pending sync operations.';
    const actions = document.createElement('div');
    actions.className = 'recovery-actions';
    const update = document.createElement('button');
    update.type = 'button';
    update.className = 'btn-primary';
    update.textContent = 'Update now';
    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'btn-action';
    later.textContent = 'Later';
    actions.append(update, later);
    notice.append(message, actions);
    (document.querySelector('main') || document.body).prepend(notice);

    later.addEventListener('click', () => notice.remove());
    update.addEventListener('click', async () => {
      update.disabled = true;
      update.textContent = 'Checking pending changes…';
      const pending = await queueCount();
      if (pending === null) {
        update.disabled = false;
        update.textContent = 'Update now';
        message.textContent =
          'Local sync status is unavailable. The update is postponed to avoid interrupting local data operations.';
        return;
      }
      if (window.db?.isBusy?.()) {
        update.disabled = false;
        update.textContent = 'Update now';
        message.textContent = `Synchronization is in progress. Wait for it to finish, then update. ${pending} operation(s) remain queued.`;
        return;
      }
      if (pending > 0) {
        const confirmMessage = `${pending} operation(s) have not been confirmed by the server. This update preserves the IndexedDB queue but will reload the page. Continue?`;
        const confirmed = window.HealthSysUI?.confirmAction
          ? await window.HealthSysUI.confirmAction(
              confirmMessage,
              'Update with pending changes',
            )
          : window.confirm(confirmMessage);
        if (!confirmed) {
          update.disabled = false;
          update.textContent = 'Update now';
          return;
        }
      }
      message.textContent =
        'Activating the update. Your local patient records and queue are preserved.';
      if (!(await requestUpdateActivation(registration?.waiting))) {
        update.disabled = false;
        update.textContent = 'Update now';
        message.textContent =
          'The update could not be started. Your patient records and queued changes were not changed.';
      }
    });
  }

  function checkWaitingWorker() {
    if (registration?.waiting && navigator.serviceWorker.controller) {
      updateAvailable = true;
      showUpdateNotice();
    }
  }

  async function cacheDiagnostics() {
    if (!('caches' in window)) return;
    try {
      const worker = registration?.waiting || registration?.active;
      let version = 'healthsys-v54';
      if (worker) {
        const response = await new Promise((resolve) => {
          const channel = new MessageChannel();
          const timeout = setTimeout(() => {
            channel.port1.close();
            resolve(null);
          }, 1500);
          channel.port1.onmessage = (event) => {
            clearTimeout(timeout);
            channel.port1.close();
            resolve(event.data?.version || null);
          };
          worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
        });
        if (typeof response === 'string') version = response;
      }
      if (!(await caches.keys()).includes(version)) {
        developmentLog(
          'No cache exists for the active service-worker version yet.',
        );
        return;
      }
      const cache = await caches.open(version);
      const required = [
        '/offline.html',
        '/offline-workspace.html',
        '/offline-workspace.css',
        '/js/offline-access.js',
        '/js/offline-workspace.js',
        '/js/offline-status.js',
        '/style.css',
        '/js/db.js',
        '/js/dexie.min.js',
      ];
      const missing = [];
      for (const path of required) {
        if (!(await cache.match(path))) missing.push(path);
      }
      if (missing.length)
        developmentLog(
          'Required cached resources are missing.',
          missing.join(', '),
        );
      else developmentLog('Required offline shell resources are cached.');
    } catch (error) {
      developmentLog('Cache diagnostics failed.', error?.name || 'CACHE_ERROR');
    }
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      developmentLog('Service workers are not supported in this browser.');
      return;
    }
    if (!window.isSecureContext) {
      developmentLog(
        'Service worker requires a secure HTTPS or localhost context.',
      );
      return;
    }

    try {
      hadController = Boolean(navigator.serviceWorker.controller);
      registration = await navigator.serviceWorker.register(
        '/service-worker.js',
        {
          scope: '/',
          updateViaCache: 'none',
        },
      );
      developmentLog('Service worker registered.', registration.scope);
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (
            installing.state === 'installed' &&
            navigator.serviceWorker.controller
          ) {
            updateAvailable = true;
            showUpdateNotice();
          }
          if (installing.state === 'redundant') {
            developmentLog(
              'New service worker became redundant before activation.',
            );
          }
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController) window.location.reload();
      });
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'ACTIVATION_BLOCKED') {
          activationRequested = false;
          const update = document.querySelector(`#${UPDATE_NOTICE_ID} button`);
          if (update) {
            update.disabled = false;
            update.textContent = 'Update now';
          }
          const message = document.querySelector(`#${UPDATE_NOTICE_ID} p`);
          if (message)
            message.textContent =
              'The update is waiting because a page is opening local storage or performing a write/sync. Finish that action, then try again.';
          showUpdateNotice();
        }
        if (event.data?.type === 'CHECK_UPDATE_SAFETY') {
          const safe = !window.db?.isBusy?.();
          event.ports?.[0]?.postMessage({ safe });
          event.ports?.[0]?.close();
        }
      });
      await registration.update();
      checkWaitingWorker();
      await cacheDiagnostics();
      if (!navigator.serviceWorker.controller) {
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            developmentLog('Service worker now controls this page.');
          },
          { once: true },
        );
      }
    } catch (error) {
      developmentLog(
        'Service worker registration or update check failed.',
        error?.name || 'REGISTRATION_ERROR',
      );
      const notice = document.createElement('p');
      notice.className = 'notice notice-warn';
      notice.setAttribute('role', 'status');
      notice.textContent =
        'Offline app support could not be initialized. This page still requires a network connection to reload.';
      (document.querySelector('main') || document.body).prepend(notice);
    }
  }

  function setupInstallPrompt() {
    if (
      window.location.pathname !== '/login' ||
      !deferredInstallPrompt ||
      installPromptDismissed ||
      installNotice ||
      window.matchMedia?.('(display-mode: standalone)').matches ||
      navigator.standalone
    )
      return;
    const notice = document.createElement('section');
    installNotice = notice;
    notice.className = 'notice notice-info';
    notice.setAttribute('role', 'region');
    notice.setAttribute('aria-label', 'Install HealthSys');
    const message = document.createElement('p');
    message.textContent = 'Install HealthSys for a home-screen app experience.';
    const install = document.createElement('button');
    install.type = 'button';
    install.className = 'btn-primary';
    install.textContent = 'Install HealthSys';
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'btn-action';
    dismiss.textContent = 'Later';
    dismiss.setAttribute('aria-label', 'Dismiss install prompt');
    notice.append(message, install, dismiss);

    window.addEventListener(
      'appinstalled',
      () => {
        notice.remove();
        installNotice = null;
      },
      { once: true },
    );
    dismiss.addEventListener('click', dismissInstallPromptForSession);
    install.addEventListener('click', async () => {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      developmentLog(
        'Installation prompt completed.',
        choice?.outcome || 'unknown',
      );
      deferredInstallPrompt = null;
      dismissInstallPromptForSession();
    });
    if (document.querySelector('main'))
      document.querySelector('main').prepend(notice);
    else document.body.prepend(notice);
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    setupInstallPrompt();
  });

  if (document.readyState === 'complete') registerServiceWorker();
  else window.addEventListener('load', registerServiceWorker, { once: true });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupInstallPrompt, {
      once: true,
    });
  } else {
    setupInstallPrompt();
  }
})();
