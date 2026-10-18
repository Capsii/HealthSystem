(function () {
  const STORAGE_KEY = 'healthsys:offline-access:v1';
  const MAX_AGE_MS = 8 * 60 * 60 * 1000;

  function save(user) {
    if (!user || typeof user.id !== 'string' || !user.id.trim()) {
      throw new Error(
        'HealthSys did not return a valid offline account identity.',
      );
    }
    const verifiedAt = Date.now();
    const context = {
      userId: user.id,
      username: typeof user.username === 'string' ? user.username : '',
      role: typeof user.role === 'string' ? user.role : '',
      verifiedAt,
      expiresAt: verifiedAt + MAX_AGE_MS,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(context));
    } catch (error) {
      console.error(
        '[OFFLINE ACCESS] Could not save the local access context:',
        error,
      );
      throw new Error(
        'Offline access could not be enabled because browser storage is unavailable.',
      );
    }
    return context;
  }

  function read() {
    let value;
    try {
      value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (error) {
      console.error(
        '[OFFLINE ACCESS] Could not read the local access context:',
        error,
      );
      return null;
    }
    if (
      !value ||
      typeof value.userId !== 'string' ||
      !value.userId ||
      !Number.isFinite(value.verifiedAt) ||
      !Number.isFinite(value.expiresAt) ||
      Date.now() >= value.expiresAt ||
      value.expiresAt - value.verifiedAt > MAX_AGE_MS ||
      value.verifiedAt > Date.now()
    ) {
      return null;
    }
    return value;
  }

  function clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.error(
        '[OFFLINE ACCESS] Could not clear the local access context:',
        error,
      );
    }
  }

  function rememberRenderedUser() {
    const { userId, userName, userRole } = document.body.dataset;
    if (!userId) return null;
    try {
      return save({ id: userId, username: userName, role: userRole });
    } catch (error) {
      console.error(
        '[OFFLINE ACCESS] The signed-in page could not establish offline access:',
        error,
      );
      return null;
    }
  }

  window.HealthSysOfflineAccess = {
    save,
    read,
    clear,
    rememberRenderedUser,
    maxAgeMs: MAX_AGE_MS,
  };
})();
