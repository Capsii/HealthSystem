(function () {
  function updateConnectionMessage() {
    const status = document.getElementById('offlineStatus');
    if (!status) return;
    status.textContent = navigator.onLine
      ? 'A network connection is available. Retry to request the page from HealthSys; no operation has been confirmed yet.'
      : 'You are offline. The requested page or server operation has not been completed.';
  }

  document.getElementById('retryConnection')?.addEventListener('click', () => location.reload());
  window.addEventListener('online', updateConnectionMessage);
  window.addEventListener('offline', updateConnectionMessage);
})();
