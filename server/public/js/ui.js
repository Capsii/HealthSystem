(function () {
    const INSTALL_PROMPT_DISMISSED_KEY = 'healthsys-install-prompt-dismissed';

    const sidebar = document.querySelector('.sidebar');
    const nav = sidebar?.querySelector('.sidebar-nav');
    const dashboard = document.querySelector('.dashboard-container');

    function buildNavigationControls() {
        if (!sidebar || !nav || !dashboard) return;

        const header = sidebar.querySelector('.sidebar-header');
        if (header && !header.querySelector('[data-sidebar-toggle]')) {
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'sidebar-toggle';
            toggle.dataset.sidebarToggle = '';
            toggle.setAttribute('aria-label', 'Collapse navigation');
            toggle.setAttribute('aria-expanded', 'true');
            toggle.title = 'Collapse navigation';
            const icon = document.createElement('i');
            icon.className = 'fas fa-chevron-left';
            icon.setAttribute('aria-hidden', 'true');
            toggle.append(icon);
            header.append(toggle);
        }

        const toggle = header?.querySelector('[data-sidebar-toggle]');
        toggle?.addEventListener('click', () => {
            const collapsed = dashboard.classList.toggle('sidebar-collapsed');
            const label = collapsed ? 'Expand navigation' : 'Collapse navigation';
            toggle.setAttribute('aria-expanded', String(!collapsed));
            toggle.setAttribute('aria-label', label);
            toggle.title = label;
            const icon = toggle.querySelector('i');
            if (icon) icon.className = `fas fa-chevron-${collapsed ? 'right' : 'left'}`;
        });

        const path = window.location.pathname;
        nav.querySelectorAll('a.nav-item').forEach((link) => {
            const href = new URL(link.href, window.location.origin).pathname;
            const active =
                href === '/patients'
                    ? path === href || path.startsWith(`${href}/`)
                    : path === href || (href !== '/dashboard' && path.startsWith(`${href}/`));
            link.classList.toggle('active', active);
            if (active) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });

        let menu = document.querySelector('[data-mobile-menu]');
        if (!menu) {
            menu = document.createElement('button');
            menu.type = 'button';
            menu.className = 'mobile-menu-toggle';
            menu.dataset.mobileMenu = '';
            menu.setAttribute('aria-expanded', 'false');
            menu.setAttribute('aria-controls', 'healthsys-sidebar');
            menu.textContent = 'Menu';
            const title = document.querySelector('.navbar .page-title');
            title?.prepend(menu);
            sidebar.id = 'healthsys-sidebar';

            const backdrop = document.createElement('button');
            backdrop.type = 'button';
            backdrop.className = 'nav-backdrop';
            backdrop.setAttribute('aria-label', 'Close navigation');
            backdrop.tabIndex = -1;
            dashboard.prepend(backdrop);

            const updateSidebarAccessibility = () => {
                const mobile = window.matchMedia('(max-width: 700px)').matches;
                const open = dashboard.classList.contains('mobile-nav-open');
                sidebar.inert = mobile && !open;
                sidebar.setAttribute('aria-hidden', String(mobile && !open));
                if (!mobile) {
                    dashboard.classList.remove('mobile-nav-open');
                    menu.setAttribute('aria-expanded', 'false');
                }
            };
            const closeMenu = () => {
                dashboard.classList.remove('mobile-nav-open');
                menu.setAttribute('aria-expanded', 'false');
                updateSidebarAccessibility();
            };
            menu.addEventListener('click', () => {
                const open = dashboard.classList.toggle('mobile-nav-open');
                menu.setAttribute('aria-expanded', String(open));
                updateSidebarAccessibility();
                if (open) nav.querySelector('a')?.focus();
            });
            const closeAndReturnFocus = () => {
                closeMenu();
                menu.focus();
            };
            backdrop.addEventListener('click', closeAndReturnFocus);
            nav.addEventListener('click', (event) => {
                if (event.target.closest('a')) closeMenu();
            });
            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape' && dashboard.classList.contains('mobile-nav-open')) closeAndReturnFocus();
                if (event.key === 'Tab' && dashboard.classList.contains('mobile-nav-open')) {
                    const focusable = Array.from(sidebar.querySelectorAll('a[href],button:not(:disabled)'));
                    const first = focusable[0];
                    const last = focusable[focusable.length - 1];
                    if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last?.focus();
                    } else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first?.focus();
                    }
                }
            });
            window.matchMedia('(max-width: 700px)').addEventListener('change', updateSidebarAccessibility);
            updateSidebarAccessibility();
        }
    }

    function buildStatusControls() {
        const header = document.querySelector('.navbar');
        const authCard = document.body.dataset.userId ? document.querySelector('.auth-card') : null;
        const container = header || authCard;
        if (!container) return;
        let controls = container.querySelector('.user-controls');
        if (!controls) {
            controls = document.createElement('div');
            controls.className = header ? 'user-controls' : 'user-controls auth-app-status';
            if (header) header.append(controls);
            else container.prepend(controls);
        }
        if (!document.getElementById('connectionStatus')) {
            const status = document.createElement('div');
            status.id = 'connectionStatus';
            status.className = 'status-indicator checking';
            status.setAttribute('role', 'status');
            status.innerHTML =
                '<span class="status-dot" aria-hidden="true"></span><span id="statusText">Checking server…</span>';
            controls.prepend(status);
        }
        if (document.body.dataset.userId && !controls.querySelector('[data-current-user]')) {
            const identity = document.createElement('span');
            identity.dataset.currentUser = '';
            identity.textContent = `${document.body.dataset.userName || 'Signed in'}${document.body.dataset.userRole ? ` (${document.body.dataset.userRole})` : ''}`;
            controls.append(identity);
        }
        if (document.body.dataset.userId && !controls.querySelector('form[data-logout]')) {
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = '/logout';
            form.dataset.logout = '';
            const token = document.createElement('input');
            token.type = 'hidden';
            token.name = '_csrf';
            token.value = document.body.dataset.csrfToken || '';
            const logout = document.createElement('button');
            logout.type = 'submit';
            logout.className = 'btn-primary dashboard-logout';
            logout.textContent = 'Logout';
            form.append(token, logout);
            controls.append(form);
        }
        if (document.body.dataset.userId && !controls.querySelector('[data-pending-count]')) {
            const pending = document.createElement('span');
            pending.className = 'pending-indicator';
            pending.dataset.pendingCount = '';
            pending.setAttribute('aria-live', 'polite');
            pending.textContent = 'Pending changes: checking';
            controls.prepend(pending);
        }
        if (document.body.dataset.userId && !controls.querySelector('[data-sync-indicator]')) {
            const sync = document.createElement('span');
            sync.className = 'sync-indicator';
            sync.dataset.syncIndicator = '';
            sync.setAttribute('role', 'status');
            sync.setAttribute('aria-live', 'polite');
            sync.hidden = true;
            controls.prepend(sync);
        }
    }

    function buildFeedbackComponents() {
        if (!document.querySelector('[data-toast-region]')) {
            const region = document.createElement('div');
            region.className = 'toast-region';
            region.dataset.toastRegion = '';
            region.setAttribute('aria-live', 'polite');
            region.setAttribute('aria-relevant', 'additions');
            document.body.append(region);
        }

        if (!document.querySelector('[data-confirm-dialog]')) {
            const dialog = document.createElement('dialog');
            dialog.className = 'confirm-dialog';
            dialog.dataset.confirmDialog = '';
            dialog.setAttribute('aria-labelledby', 'confirmDialogTitle');
            dialog.innerHTML =
                '<form method="dialog"><h2 id="confirmDialogTitle">Confirm action</h2><p data-confirm-text></p><div class="confirm-actions"><button type="submit" value="cancel" class="btn-reset">Cancel</button><button type="submit" value="confirm" class="btn-primary">Confirm</button></div></form>';
            document.body.append(dialog);
        }
    }

    function notify(message, type = 'info', persistent = false) {
        const region = document.querySelector('[data-toast-region]');
        if (!region) return;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        const text = document.createElement('span');
        text.textContent = message;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'toast-dismiss';
        close.setAttribute('aria-label', 'Dismiss notification');
        close.textContent = 'Dismiss';
        close.addEventListener('click', () => toast.remove());
        toast.append(text, close);
        region.append(toast);
        if (!persistent) window.setTimeout(() => toast.remove(), 8000);
    }

    function confirmAction(message, title = 'Confirm action') {
        const dialog = document.querySelector('[data-confirm-dialog]');
        if (!dialog || typeof dialog.showModal !== 'function') {
            notify(
                'This browser does not support the accessible confirmation dialog; no action was taken.',
                'error',
                true,
            );
            return Promise.resolve(false);
        }
        dialog.querySelector('#confirmDialogTitle').textContent = title;
        dialog.querySelector('[data-confirm-text]').textContent = message;
        return new Promise((resolve) => {
            const finish = () => {
                dialog.removeEventListener('close', onClose);
                resolve(dialog.returnValue === 'confirm');
            };
            const onClose = () => finish();
            dialog.addEventListener('close', onClose, { once: true });
            dialog.showModal();
            dialog.querySelector('[value="cancel"]').focus();
        });
    }

    function updatePendingCount() {
        const element = document.querySelector('[data-pending-count]');
        if (!element || !window.db?.getQueueStatus) return;
        window.db
            .getQueueStatus()
            .then((queue) => {
                element.textContent = `Pending changes: ${queue.pending}${queue.processing ? ` · ${queue.processing} processing` : ''}${queue.failed ? ` · ${queue.failed} failed` : ''}`;
            })
            .catch((error) => {
                console.error('[UI] Could not read local synchronization queue:', error);
                element.textContent = 'Pending changes: unavailable';
            });
    }

    function renderSyncStatus(outcome) {
        const element = document.querySelector('[data-sync-indicator]');
        if (!element) return;
        if (!outcome) {
            element.hidden = true;
            return;
        }
        element.hidden = false;
        element.textContent = `Sync: ${outcome}`;
        element.dataset.outcome = outcome.toLowerCase().replaceAll(' ', '-');
    }

    function observeForms() {
        document.querySelectorAll('form').forEach((form) => {
            if (form.method.toLowerCase() === 'dialog' || form.closest('[data-confirm-dialog]')) return;
            if (form.dataset.unsavedWarning !== 'false' && form.method.toLowerCase() !== 'get') {
                const initial = new URLSearchParams(new FormData(form)).toString();
                form.dataset.initialValues = initial;
                form.addEventListener('input', () => {
                    form.dataset.dirty = String(
                        new URLSearchParams(new FormData(form)).toString() !== form.dataset.initialValues,
                    );
                });
                form.addEventListener('change', () => {
                    form.dataset.dirty = String(
                        new URLSearchParams(new FormData(form)).toString() !== form.dataset.initialValues,
                    );
                });
                form.addEventListener('reset', () => {
                    window.setTimeout(() => {
                        form.dataset.dirty = String(
                            new URLSearchParams(new FormData(form)).toString() !== form.dataset.initialValues,
                        );
                    });
                });
            }

            form.addEventListener('submit', (event) => {
                if (event.defaultPrevented || form.dataset.confirmPending === 'true') return;
                if (form.dataset.submitting === 'true') {
                    event.preventDefault();
                    return;
                }
                form.dataset.submitting = 'true';
                form.dataset.dirty = 'false';
                form.setAttribute('aria-busy', 'true');
                const button = event.submitter || form.querySelector('button[type="submit"],input[type="submit"]');
                if (button && !button.disabled) {
                    button.dataset.originalText = button.textContent || button.value;
                    button.disabled = true;
                    if (button.tagName === 'INPUT') button.value = 'Please wait…';
                    else button.textContent = 'Please wait…';
                }
            });
        });
    }

    function observeDialogControls() {
        document.addEventListener('click', (event) => {
            const toggle = event.target.closest('[data-password-toggle]');
            if (!toggle) return;
            const field = document.getElementById(toggle.dataset.passwordToggle);
            if (!field) return;
            const visible = field.type === 'password';
            field.type = visible ? 'text' : 'password';
            toggle.textContent = visible ? 'Hide' : 'Show';
            toggle.setAttribute('aria-pressed', String(visible));
            toggle.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} password`);
        });

        document.addEventListener('keydown', (event) => {
            const dialog = event.target.closest('[role="dialog"][aria-modal="true"]');
            if (!dialog) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                const modal = dialog.closest('.modal');
                if (modal?.id) window.closeModal?.(modal.id);
                return;
            }
            if (event.key !== 'Tab') return;
            const items = Array.from(
                dialog.querySelectorAll(
                    'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
                ),
            );
            if (!items.length) return;
            if (event.shiftKey && document.activeElement === items[0]) {
                event.preventDefault();
                items[items.length - 1].focus();
            } else if (!event.shiftKey && document.activeElement === items[items.length - 1]) {
                event.preventDefault();
                items[0].focus();
            }
        });
    }

    function interceptConfirmations() {
        document.addEventListener(
            'submit',
            async (event) => {
                const form = event.target;
                if (!(form instanceof HTMLFormElement) || !form.dataset.confirm || form.dataset.confirmed === 'true')
                    return;
                event.preventDefault();
                if (form.dataset.confirmPending === 'true') return;
                form.dataset.confirmPending = 'true';
                const confirmed = await confirmAction(
                    form.dataset.confirm,
                    form.dataset.confirmTitle || 'Confirm action',
                );
                form.dataset.confirmPending = 'false';
                if (confirmed) {
                    form.dataset.confirmed = 'true';
                    form.requestSubmit();
                }
            },
            true,
        );
    }

    function bindLogout() {
        document.addEventListener('submit', async (event) => {
            const form = event.target.closest('form[data-logout]');
            if (!form) return;
            event.preventDefault();
            let queueStatus = null;
            try {
                queueStatus = await window.db?.getQueueStatus?.();
            } catch (error) {
                console.error('[LOGOUT] Could not verify local pending changes:', error?.name || 'DATABASE_ERROR');
            }
            const pendingCount = Number(queueStatus?.total || 0) + Number(queueStatus?.reviewRequired || 0);
            if (queueStatus && pendingCount > 0) {
                const confirmed = await confirmAction(
                    `There are ${pendingCount} unsynchronized or review-required operation(s) on this device. Logout preserves the queue but clears local patient snapshots. Download a local offline backup from the dashboard first if you need a portable copy. Continue logging out?`,
                    'Unsynchronized changes remain on this device',
                );
                if (!confirmed) return;
            } else if (!queueStatus) {
                const confirmed = await confirmAction(
                    'The local sync queue could not be checked. Logout does not delete queued operations, but unsynchronized changes may remain on this device. Continue?',
                    'Local sync status unavailable',
                );
                if (!confirmed) return;
            }
            const button = form.querySelector('[type="submit"]');
            if (button) {
                button.disabled = true;
                button.textContent = 'Signing out…';
            }
            try {
                const response = await fetch('/logout', {
                    method: 'POST',
                    credentials: 'same-origin',
                    cache: 'no-store',
                    headers: { Accept: 'text/html' },
                    body: new URLSearchParams(new FormData(form)),
                });
                if (!response.ok) throw new Error(`Sign out failed with HTTP ${response.status}.`);
                window.HealthSysOfflineAccess?.clear();
                try {
                    window.sessionStorage.removeItem(INSTALL_PROMPT_DISMISSED_KEY);
                } catch (error) {
                    console.error(
                        '[LOGOUT] Install prompt state could not be cleared:',
                        error?.name || 'SESSION_STORAGE_ERROR',
                    );
                }
                try {
                    await window.db?.clearSensitiveLocalData?.();
                } catch (error) {
                    console.error(
                        '[LOGOUT] Local patient snapshots could not be cleared:',
                        error?.name || 'DATABASE_ERROR',
                    );
                    notify(
                        'You have been signed out, but local data cleanup could not be verified. Secure this device and contact an administrator.',
                        'error',
                        true,
                    );
                }
                navigator.serviceWorker?.controller?.postMessage({
                    type: 'clear-private-cache',
                });
                window.location.assign('/login');
            } catch (error) {
                if (button) {
                    button.disabled = false;
                    button.textContent = 'Logout';
                }
                notify(error.message || 'Unable to sign out. Please try again.', 'error', true);
            }
        });
    }

    function observeUnsavedChanges() {
        window.addEventListener('beforeunload', (event) => {
            const dirty = Array.from(document.querySelectorAll('form[data-dirty="true"]')).some(
                (form) => form.dataset.submitting !== 'true',
            );
            if (dirty) {
                event.preventDefault();
                event.returnValue = '';
            }
        });
    }

    function displayDatabaseRecoveryNotice() {
        if (!window.healthsysDBError || document.getElementById('databaseRecoveryNotice')) return;
        const notice = document.createElement('div');
        notice.id = 'databaseRecoveryNotice';
        notice.className = 'notice notice-error';
        notice.setAttribute('role', 'alert');
        notice.textContent = `${window.healthsysDBError} Do not clear site data or reinstall the app.`;
        (document.querySelector('main') || document.body).prepend(notice);
    }

    document.addEventListener(
        'DOMContentLoaded',
        () => {
            buildNavigationControls();
            buildStatusControls();
            buildFeedbackComponents();
            observeForms();
            observeDialogControls();
            interceptConfirmations();
            bindLogout();
            observeUnsavedChanges();
            displayDatabaseRecoveryNotice();
            updatePendingCount();
            window.addEventListener('healthsys:queue-updated', updatePendingCount);
            window.addEventListener('healthsys:queue-changed', updatePendingCount);
            window.addEventListener('healthsys:sync-state', (event) => renderSyncStatus(event.detail?.lastOutcome));
            window.addEventListener('healthsys:sync-progress', (event) => {
                const { completed, total } = event.detail || {};
                renderSyncStatus(
                    Number.isInteger(total) && Number.isInteger(completed)
                        ? `In Progress (${completed}/${total})`
                        : 'In Progress',
                );
            });
            renderSyncStatus(window.db?.getSyncMetadata?.()?.lastOutcome);
        },
        { once: true },
    );
    window.addEventListener('healthsys:database-error', displayDatabaseRecoveryNotice);

    window.HealthSysUI = {
        notify,
        confirmAction,
        refreshPendingCount: updatePendingCount,
        formatTimestamp(value) {
            if (!value) return 'Not available';
            const text = String(value);
            const date = new Date(
                /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text) ? `${text.replace(' ', 'T')}Z` : text,
            );
            if (Number.isNaN(date.getTime())) return 'Not available';
            return `${date.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' })} UTC`;
        },
    };
})();
