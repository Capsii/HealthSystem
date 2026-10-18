(function () {
  const csrfToken = document.body.dataset.csrfToken || '';
  let csvText = null;
  let csvPreview = null;
  let backupText = null;
  let canRestore = false;

  async function readResponse(response) {
    const body = await response.json().catch(() => null);
    if (!body) throw new Error('The server returned an unreadable response.');
    if (!response.ok) throw new Error(body.error || `Request failed with HTTP ${response.status}.`);
    return body;
  }

  function setStatus(id, message, isError = false) {
    const target = document.getElementById(id);
    if (!target) return;
    target.replaceChildren(document.createTextNode(message));
    target.classList.toggle('notice-error', isError);
    target.classList.toggle('notice-success', !isError && Boolean(message));
  }

  async function selectedText(inputId, maxBytes, fileLabel) {
    const input = document.getElementById(inputId);
    const file = input?.files?.[0];
    if (!file) throw new Error(`Choose a ${fileLabel} first.`);
    if (
      fileLabel === 'CSV file' &&
      !/\.csv$/i.test(file.name) &&
      !['text/csv', 'text/plain', 'application/vnd.ms-excel'].includes(file.type)
    ) {
      throw new Error('Choose a CSV file.');
    }
    if (!file.size) throw new Error(`${fileLabel} is empty.`);
    if (file.size > maxBytes) throw new Error(`${fileLabel} exceeds the upload size limit.`);
    return file.text();
  }

  function csvCell(value) {
    const text = String(value ?? '').replace(/^[\s]*[=+\-@\t\r]/, (match) => `'${match}`);
    return `"${text.replaceAll('"', '""')}"`;
  }

  function downloadCsv(name, rows) {
    const body = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
    const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  function showCsvPreview(preview) {
    const output = document.getElementById('csv-status');
    const summary = document.createElement('p');
    summary.textContent =
      `${preview.counts.valid} importable, ${preview.counts.rejected} invalid/review rows, ` +
      `${preview.counts.duplicates || 0} existing-ID duplicates, ` +
      `${preview.counts.potentialMatches || 0} potential phone matches, ` +
      `${preview.counts.skipped} blank rows skipped.`;
    const fragment = document.createDocumentFragment();
    fragment.append(summary);
    if (preview.validRows.length) {
      const validHeading = document.createElement('strong');
      validHeading.textContent = `Valid patient rows (showing ${preview.validRowsShown}):`;
      fragment.append(validHeading);
      const table = document.createElement('table');
      table.className = 'recovery-table';
      const head = document.createElement('thead');
      const headingRow = document.createElement('tr');
      for (const label of ['CSV row', 'Patient ID', 'Name', 'Date of birth', 'Gender', 'Phone']) {
        const cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = label;
        headingRow.append(cell);
      }
      head.append(headingRow);
      table.append(head);
      const body = document.createElement('tbody');
      for (const row of preview.validRows) {
        const tableRow = document.createElement('tr');
        for (const value of [
          row.row,
          row.id,
          row.full_name,
          row.date_of_birth,
          row.gender,
          row.phone,
        ]) {
          const cell = document.createElement('td');
          cell.textContent = String(value);
          tableRow.append(cell);
        }
        body.append(tableRow);
      }
      table.append(body);
      fragment.append(table);
    }
    if (preview.invalidRows.length) {
      const heading = document.createElement('strong');
      heading.textContent = 'Rows requiring correction:';
      fragment.append(heading);
      const list = document.createElement('ul');
      for (const row of preview.invalidRows) {
        const item = document.createElement('li');
        item.textContent =
          `Row ${row.row}${row.id ? ` (ID ${row.id})` : ''}: ` +
          row.errors.map((error) => `${error.column}: ${error.message}`).join(' ');
        if (row.matches?.length) {
          item.textContent +=
            ` Potential existing IDs: ${row.matches.join(', ')}` +
            (row.matchCount > row.matches.length ? `, and ${row.matchCount - row.matches.length} more.` : '.');
        }
        list.append(item);
      }
      fragment.append(list);
    }
    output.replaceChildren(fragment);
    document.getElementById('csv-import').disabled =
      preview.counts.valid === 0 || preview.counts.rejected > 0;
    const errorsButton = document.getElementById('csv-errors');
    if (errorsButton) errorsButton.hidden = preview.invalidRows.length === 0;
    csvPreview = preview;
  }

  async function previewCsv() {
    const button = document.getElementById('csv-preview');
    const fileInfo = document.getElementById('csv-file-info');
    button.disabled = true;
    document.getElementById('csv-import').disabled = true;
    setStatus('csv-status', 'Reading and validating CSV rows…');
    try {
      const input = document.getElementById('csv-file');
      const file = input?.files?.[0];
      const maxBytes = Number(document.body.dataset.csvMaxBytes) || 2 * 1024 * 1024;
      if (fileInfo && file) {
        fileInfo.textContent = `${file.name} · ${file.size.toLocaleString()} bytes`;
      }
      csvText = await selectedText('csv-file', maxBytes, 'CSV file');
      const response = await fetch('/admin/recovery/csv/preview', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: csvText,
      });
      showCsvPreview(await readResponse(response));
    } catch (error) {
      csvText = null;
      csvPreview = null;
      setStatus('csv-status', error.message || 'CSV preview failed.', true);
    } finally {
      button.disabled = false;
    }
  }

  async function importCsv() {
    if (csvText === null) return;
    if (!window.confirm('Import all validated rows as new active patients? Existing records will not be overwritten.')) return;
    const button = document.getElementById('csv-import');
    button.disabled = true;
    setStatus('csv-status', 'Importing validated patient records…');
    try {
      const response = await fetch('/admin/recovery/csv/import', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken,
          'X-Import-Confirmed': 'yes',
        },
        body: csvText,
      });
      const result = await readResponse(response);
      setStatus('csv-status', `Import complete: ${result.summary.imported} imported, ${result.summary.skipped} blank rows skipped, ${result.summary.rejected} rejected, ${result.summary.failed} failed.`);
      csvText = null;
    } catch (error) {
      setStatus('csv-status', error.message || 'CSV import failed. No success is assumed.', true);
      button.disabled = false;
    }
  }

  async function previewRestore() {
    const button = document.getElementById('restore-preview');
    button.disabled = true;
    canRestore = false;
    document.getElementById('restore-commit').disabled = true;
    setStatus('restore-status', 'Reading backup file and checking its structure and target database…');
    try {
      backupText = await selectedText('backup-file', 50 * 1024 * 1024, 'server backup');
      const response = await fetch('/admin/recovery/backup/restore/preview', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: backupText,
      });
      const result = await readResponse(response);
      const countSummary = Object.entries(result.counts)
        .map(([dataset, count]) => `${dataset}: ${count}`)
        .join(', ');
      const targetReady = result.freshTarget && result.passwordReady;
      canRestore = targetReady;
      setStatus(
        'restore-status',
        `Backup timestamp: ${result.createdAt}. Administrator: ${result.bootstrapAdmin}. ${countSummary}. ` +
          (result.freshTarget ? 'Fresh target confirmed.' : 'Target is not fresh; restoration is blocked.') +
          (result.passwordReady ? '' : ' RESTORE_ADMIN_PASSWORD is missing or does not meet password policy.') +
          ` ${result.warning}`,
        !targetReady
      );
      document.getElementById('restore-commit').disabled = !targetReady;
    } catch (error) {
      backupText = null;
      setStatus('restore-status', error.message || 'Backup validation failed.', true);
    } finally {
      button.disabled = false;
    }
  }

  async function commitRestore() {
    if (!backupText || !canRestore) return;
    const confirmation = window.prompt('This replaces the temporary Admin and loads backup data. Type RESTORE to continue.');
    if (confirmation !== 'RESTORE') return;
    const button = document.getElementById('restore-commit');
    button.disabled = true;
    setStatus('restore-status', 'Restoring database records. Keep this page open until the server confirms completion.');
    try {
      const response = await fetch('/admin/recovery/backup/restore', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken,
          'X-Restore-Confirmation': 'RESTORE',
        },
        body: backupText,
      });
      const result = await readResponse(response);
      setStatus('restore-status', `${result.message} Restored dataset counts: ${JSON.stringify(result.counts)}.`);
      backupText = null;
      canRestore = false;
    } catch (error) {
      setStatus('restore-status', error.message || 'Restore failed. Verify the target before retrying.', true);
      button.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('csv-preview')?.addEventListener('click', previewCsv);
    document.getElementById('csv-import')?.addEventListener('click', importCsv);
    document.getElementById('restore-preview')?.addEventListener('click', previewRestore);
    document.getElementById('restore-commit')?.addEventListener('click', commitRestore);
    document.getElementById('csv-file')?.addEventListener('change', (event) => {
      csvText = null;
      csvPreview = null;
      document.getElementById('csv-import').disabled = true;
      document.getElementById('csv-errors').hidden = true;
      const file = event.target.files?.[0];
      const limit = Number(document.body.dataset.csvMaxBytes) || 2 * 1024 * 1024;
      document.getElementById('csv-file-info').textContent = file
        ? `${file.name} · ${file.size.toLocaleString()} bytes${file.size > limit ? ' · exceeds upload limit' : ''}`
        : 'No file selected.';
      setStatus('csv-status', '');
    });
    document.getElementById('csv-errors')?.addEventListener('click', () => {
      if (!csvPreview?.invalidRows?.length) return;
      downloadCsv('healthsys-csv-import-errors.csv', [
        ['CSV row', 'Column', 'Validation error'],
        ...csvPreview.invalidRows.flatMap((row) =>
          row.errors.map((error) => [row.row, error.column, error.message]),
        ),
      ]);
    });
    document.querySelector('form[action="/admin/recovery/backup"]')?.addEventListener('submit', () => {
      setStatus('backup-status', 'Preparing sensitive server backup…');
    });
  });
})();
