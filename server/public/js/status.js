let statusCheckId = 0;

function lockPrivatePage(message, allowSignIn = false) {
  if (!document.body) {
    document.addEventListener(
      'DOMContentLoaded',
      () => lockPrivatePage(message, allowSignIn),
      { once: true },
    );
    return;
  }
  const content =
    document.querySelector('.dashboard-container') ||
    document.querySelector('main');
  if (content) {
    content.hidden = true;
    content.inert = true;
    content.setAttribute('aria-hidden', 'true');
  }

  let lock = document.getElementById('offlineSessionLock');
  if (!lock) {
    lock = document.createElement('main');
    lock.id = 'offlineSessionLock';
    lock.className = 'auth-container';
    const card = document.createElement('section');
    card.className = 'auth-card';
    const heading = document.createElement('h1');
    heading.textContent = 'HealthSys needs to verify your session';
    const notice = document.createElement('p');
    notice.className = 'notice notice-warn';
    notice.setAttribute('role', 'alert');
    const explanation = document.createElement('p');
    explanation.textContent =
      'This page is locked while the server is unavailable. Patient data and queued changes remain stored; no queued operation was removed.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn-primary';
    retry.textContent = 'Reconnect and verify';
    retry.addEventListener('click', () => location.reload());
    card.append(heading, notice, explanation, retry);
    lock.append(card);
    document.body.append(lock);
  }
  lock.querySelector('[role="alert"]').textContent = message;
  let signIn = lock.querySelector('a[href="/login"]');
  if (allowSignIn && !signIn) {
    signIn = document.createElement('a');
    signIn.href = '/login';
    signIn.className = 'btn-action';
    signIn.textContent = 'Sign in again';
    lock.querySelector('.auth-card').append(signIn);
  }
}

function setServerAvailability(isAvailable, message) {
  const indicator = document.getElementById('connectionStatus');
  const text = document.getElementById('statusText');
  if (indicator) {
    indicator.classList.toggle('online', isAvailable);
    indicator.classList.toggle('offline', !isAvailable);
  }
  if (text) text.textContent = message;
}

function setConnectionStatus(isOnline) {
  const indicator = document.getElementById('connectionStatus');
  const text = document.getElementById('statusText');
  if (indicator) {
    indicator.classList.toggle('online', isOnline);
    indicator.classList.toggle('offline', !isOnline);
  }
  if (text) {
    text.textContent = !navigator.onLine
      ? 'Offline · no network'
      : isOnline
        ? 'Server reachable'
        : 'Server unavailable';
  }
}

async function checkServerStatus() {
  const checkId = ++statusCheckId;

  if (!navigator.onLine) {
    setServerAvailability(false, 'Offline · local changes are available');
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch('/session/status', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (checkId !== statusCheckId) return;
    if (response.status === 401) {
      window.HealthSysOfflineAccess?.clear();
      lockPrivatePage(
        'The server is reachable, but this sign-in is no longer valid. Sign in again to continue.',
        true,
      );
      setConnectionStatus(false);
      return;
    }
    if (!response.ok) {
      setServerAvailability(
        false,
        `Server unavailable · HTTP ${response.status}`,
      );
      window.dispatchEvent(new CustomEvent('healthsys:server-unavailable'));
      setConnectionStatus(false);
      return;
    }
    const session = await response.json().catch(() => null);
    if (session?.authenticated !== true || !session.user?.id) {
      window.HealthSysOfflineAccess?.clear();
      lockPrivatePage(
        'The server could not validate this sign-in. Sign in again to continue.',
        true,
      );
      setConnectionStatus(false);
      return;
    }

    try {
      window.HealthSysOfflineAccess?.save(session.user);
    } catch (storageError) {
      console.error(
        '[OFFLINE ACCESS] Could not establish local access:',
        storageError?.message || 'STORAGE_ERROR',
      );
    }
    if (session.csrfToken) document.body.dataset.csrfToken = session.csrfToken;
    setConnectionStatus(true);
  } catch (error) {
    if (checkId === statusCheckId) {
      const message =
        error?.name === 'AbortError'
          ? 'Server check timed out · local workspace remains available'
          : 'Server unreachable · local workspace remains available';
      setServerAvailability(false, message);
      window.dispatchEvent(new CustomEvent('healthsys:server-unavailable'));
    }
  } finally {
    clearTimeout(timeout);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkServerStatus, {
    once: true,
  });
} else {
  checkServerStatus();
}
window.addEventListener('focus', checkServerStatus);
window.addEventListener('online', checkServerStatus);
window.addEventListener('offline', () => {
  statusCheckId++;
  setServerAvailability(false, 'Offline · local changes are available');
});
setInterval(checkServerStatus, 60000);
if (document.readyState === 'loading') {
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      window.HealthSysOfflineAccess?.rememberRenderedUser();
    },
    { once: true },
  );
} else {
  window.HealthSysOfflineAccess?.rememberRenderedUser();
}
