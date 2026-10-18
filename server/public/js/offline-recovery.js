(function () {
  const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
  const BACKUP_STATUS_PREFIX = 'healthsys:local-backup-status:v1:';

  function backupStatusKey() {
    const userId = document.body.dataset.userId;
    return userId ? `${BACKUP_STATUS_PREFIX}${userId}` : null;
  }

  function renderBackupStatus() {
    const target = document.getElementById('localBackupStatus');
    const key = backupStatusKey();
    if (!target || !key) return;
    try {
      const status = JSON.parse(localStorage.getItem(key) || 'null');
      if (!status || !['success', 'failure'].includes(status.outcome) ||
          typeof status.at !== 'string' || Number.isNaN(Date.parse(status.at))) {
        target.textContent = 'No local backup export has been generated on this device for this account.';
        return;
      }
      const timestamp = window.HealthSysUI?.formatTimestamp
        ? window.HealthSysUI.formatTimestamp(status.at)
        : new Date(status.at).toLocaleString();
      target.textContent = status.outcome === 'success'
        ? `Last local backup generated ${timestamp}. The file's current location and availability cannot be verified.`
        : `Last local backup attempt failed ${timestamp}.`;
    } catch (error) {
      console.error('[RECOVERY] Local backup status could not be read:', error?.name || 'STORAGE_ERROR');
      target.textContent = 'Local backup history is unavailable.';
    }
  }

  function saveBackupStatus(outcome) {
    const key = backupStatusKey();
    if (!key) return false;
    try {
      localStorage.setItem(key, JSON.stringify({
        outcome,
        at: new Date().toISOString(),
        scope: 'local-device',
      }));
      return true;
    } catch (error) {
      console.error('[RECOVERY] Local backup status could not be saved:', error?.name || 'STORAGE_ERROR');
      return false;
    }
  }

  function setStatus(message, isError = false) {
    const target = document.getElementById('offlineRecoveryStatus');
    if (!target) return;
    target.textContent = message;
    target.classList.toggle('notice-error', isError);
    target.classList.toggle('notice-success', !isError && Boolean(message));
  }

  async function exportLocalBackup() {
    if (!window.confirm('Download a file containing patient information and unsynchronized changes from this device? Store it securely.')) {
      return;
    }
    const button = document.getElementById('exportOfflineBackup');
    button.disabled = true;
    setStatus('Preparing local-only backup…');
    try {
      const backup = await window.db.exportOfflineData();
      const contents = JSON.stringify(backup);
      const blob = new Blob([contents], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `healthsys-local-offline-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      saveBackupStatus('success');
      setStatus(`Local backup downloaded: ${backup.patients.length} patient snapshots and ${backup.pendingOperations.length} queued operations. This does not confirm server synchronization.`);
    } catch (error) {
      saveBackupStatus('failure');
      console.error('[RECOVERY] Local offline export failed:', error?.name || 'DATABASE_ERROR');
      setStatus(window.healthsysDBError || 'Local data could not be exported. Do not clear browser storage; contact an administrator for recovery help.', true);
    } finally {
      button.disabled = false;
    }
  }

  async function importLocalBackup() {
    const input = document.getElementById('importOfflineBackup');
    const file = input?.files?.[0];
    if (!file) {
      setStatus('Choose a local offline backup file first.', true);
      return;
    }
    if (file.size > MAX_BACKUP_BYTES) {
      setStatus('Local backup exceeds the 50 MB file limit.', true);
      return;
    }

    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch {
      setStatus('The selected local backup is not valid JSON.', true);
      return;
    }
    const queueCount = Array.isArray(backup.pendingOperations) ? backup.pendingOperations.length : 0;
    if (!window.confirm(`Merge this account's local backup? It contains up to ${queueCount} unsynchronized operations. Existing records and operations will not be overwritten.`)) {
      return;
    }

    const button = document.getElementById('restoreOfflineBackup');
    button.disabled = true;
    setStatus('Validating and merging local records and queued operations…');
    try {
      const result = await window.db.importOfflineData(backup);
      setStatus(`Local recovery complete: ${result.importedPatients} patient snapshots and ${result.importedOperations} operations restored. The operations still need a server sync.`);
      input.value = '';
      window.dispatchEvent(new CustomEvent('healthsys:queue-changed'));
    } catch (error) {
      console.error('[RECOVERY] Local offline import failed:', error?.name || 'VALIDATION_ERROR');
      setStatus(error.message || 'Local backup could not be restored.', true);
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    renderBackupStatus();
    document.getElementById('exportOfflineBackup')?.addEventListener('click', exportLocalBackup);
    document.getElementById('restoreOfflineBackup')?.addEventListener('click', importLocalBackup);
    if (window.healthsysDBError) setStatus(window.healthsysDBError, true);
    window.addEventListener('healthsys:database-error', () => setStatus(window.healthsysDBError, true));
  });
})();
