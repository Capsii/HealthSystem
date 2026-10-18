(function () {
  let currentPage = 1;
  let pageCount = 1;

  function textCell(row, value) {
    const cell = document.createElement('td');
    cell.textContent = value === undefined || value === null || value === ''
      ? '—'
      : String(value);
    row.append(cell);
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Not available'
      : `${date.toLocaleString('en-US', {
          timeZone: 'UTC',
          dateStyle: 'medium',
          timeStyle: 'short',
        })} UTC`;
  }

  async function loadAudit(page = 1) {
    const form = document.getElementById('audit-filters');
    const status = document.getElementById('audit-status');
    const body = document.getElementById('audit-events');
    const params = new URLSearchParams(new FormData(form));
    params.set('page', String(page));
    status.textContent = 'Loading audit history…';
    document.getElementById('audit-previous').disabled = true;
    document.getElementById('audit-next').disabled = true;
    try {
      const response = await fetch(`/admin/recovery/audit/events?${params}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Audit history could not be loaded.');
      body.replaceChildren();
      for (const event of result.events) {
        const row = document.createElement('tr');
        textCell(row, formatDate(event.created_at));
        textCell(
          row,
          event.actor_name
            ? `${event.actor_name}${event.actor_role ? ` (${event.actor_role})` : ''}`
            : event.actor_id || 'System',
        );
        textCell(row, event.action);
        textCell(
          row,
          [event.entity_type, event.entity_id || event.target_id]
            .filter(Boolean)
            .join(' · '),
        );
        textCell(row, event.outcome);
        let details = event.details || '';
        if (typeof details === 'string') {
          try {
            details = JSON.stringify(JSON.parse(details));
          } catch {
            details = String(details);
          }
        }
        const diagnostic = [
          details,
          event.failure_category ? `Category: ${event.failure_category}` : '',
          event.operation_id ? `Operation: ${event.operation_id}` : '',
        ].filter(Boolean).join(' · ');
        textCell(row, diagnostic);
        body.append(row);
      }
      currentPage = result.pagination.page;
      pageCount = result.pagination.pages;
      document.getElementById('audit-page').textContent =
        `Page ${currentPage} of ${pageCount} · ${result.pagination.total} event(s)`;
      status.textContent = result.events.length
        ? 'Audit history loaded.'
        : 'No audit events match these filters.';
      document.getElementById('audit-previous').disabled = currentPage <= 1;
      document.getElementById('audit-next').disabled = currentPage >= pageCount;
    } catch (error) {
      body.replaceChildren();
      status.textContent = error.message || 'Audit history could not be loaded.';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('audit-filters')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void loadAudit(1);
    });
    document.getElementById('audit-previous')?.addEventListener('click', () => {
      if (currentPage > 1) void loadAudit(currentPage - 1);
    });
    document.getElementById('audit-next')?.addEventListener('click', () => {
      if (currentPage < pageCount) void loadAudit(currentPage + 1);
    });
    void loadAudit();
  });
})();
