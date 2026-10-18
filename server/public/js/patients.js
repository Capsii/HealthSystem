(function () {
    const userId = document.body.dataset.userId;
    let modalOpener = null;

    function notify(message, type = 'info', persistent = false) {
        if (window.HealthSysUI?.notify) window.HealthSysUI.notify(message, type, persistent);
        else console.error(`[PATIENTS] ${message}`);
    }

    function todayDateOnly() {
        const today = new Date();
        return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    }

    function isValidDateOnly(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const [year, month, day] = value.split('-').map(Number);
        const date = new Date(Date.UTC(year, month - 1, day));
        return date.getUTCFullYear() === year &&
            date.getUTCMonth() === month - 1 &&
            date.getUTCDate() === day &&
            value <= todayDateOnly();
    }

    function normalizePhone(value) {
        const trimmed = String(value || '').trim();
        if (!trimmed || !/^\+?[0-9().\-\s]+$/.test(trimmed)) return null;
        let normalized = trimmed.replace(/[().\-\s]/g, '');
        if (normalized.startsWith('00')) normalized = `+${normalized.slice(2)}`;
        const digits = normalized.startsWith('+') ? normalized.slice(1) : normalized;
        return /^\d{7,15}$/.test(digits) ? normalized : null;
    }

    async function localDuplicateMatches(data) {
        if (typeof window.db?.getPatients !== 'function') return null;
        const records = await window.db.getPatients();
        const name = data.full_name.trim().toLocaleLowerCase();
        return records.filter((patient) =>
            !patient.is_deleted &&
            (String(patient.phone || '').trim() === data.phone ||
                (String(patient.full_name || '').trim().toLocaleLowerCase() === name &&
                    String(patient.date_of_birth || '').slice(0, 10) === data.date_of_birth)),
        );
    }

    function formatDuplicateMatches(matches) {
        return matches.map((match) => {
            const reasons = match.reasons?.map((reason) =>
                reason === 'phone' ? 'phone number' : 'name and date of birth',
            ).join(' and ') || 'matching patient details';
            return `${match.full_name} · ${match.id} (${reasons})`;
        }).join('\n');
    }

    async function postPatient(data, operationId) {
        let allowPotentialDuplicates = false;
        let acknowledgedIds = [];
        while (true) {
            const response = await fetch('/patients/add', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'X-CSRF-Token': document.body.dataset.csrfToken || '',
                },
                body: JSON.stringify({
                    ...data,
                    operationId,
                    ...(allowPotentialDuplicates
                        ? { allowPotentialDuplicates: true, duplicateAcknowledgedIds: acknowledgedIds }
                        : {}),
                }),
                cache: 'no-store',
            });
            const result = await response.json().catch(() => ({}));
            if (response.ok) return result;
            if (response.status === 409 && result.code === 'POTENTIAL_DUPLICATE' &&
                Array.isArray(result.matches)) {
                const newMatches = result.matches.filter((match) =>
                    !acknowledgedIds.includes(match.id),
                );
                const prompt = [
                    'Possible matching patient records were found:',
                    formatDuplicateMatches(newMatches.length ? newMatches : result.matches),
                    '',
                    'Verify these records before creating another. Continue only if this is a different patient.',
                ].join('\n');
                if (!window.confirm(prompt)) return null;
                allowPotentialDuplicates = true;
                acknowledgedIds = [...new Set([
                    ...acknowledgedIds,
                    ...result.matches.map((match) => match.id),
                ])];
                data.allowPotentialDuplicates = true;
                data.duplicateAcknowledgedIds = acknowledgedIds;
                continue;
            }
            throw new Error(result.error || `HTTP ${response.status}`);
        }
    }

    function isRetryableNetworkError(error) {
        if (!navigator.onLine || error instanceof TypeError) return true;
        return /HTTP (500|502|503|504)\b/.test(String(error.message || error));
    }

    function openModal(id) {
        const modal = document.getElementById(id);
        if (!modal) return;
        modalOpener = document.activeElement;
        modal.classList.add('active');
        modal.querySelector('[role="dialog"]')?.querySelector('input,select,textarea,button')?.focus();
    }

    function closeModal(id) {
        document.getElementById(id)?.classList.remove('active');
        if (modalOpener instanceof HTMLElement) modalOpener.focus();
    }

    async function refreshPatients() {
        const response = await fetch('/patients/json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Patient refresh failed: HTTP ${response.status}`);
        const patients = await response.json();
        if (!Array.isArray(patients)) throw new Error('Server returned an invalid patient list');
        await window.db.savePatients(patients);
    }

    async function handleAdd(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector('button[type="submit"]');
        if (button.disabled) return;

        const data = Object.fromEntries(new FormData(form).entries());
        data.full_name = String(data.full_name || '').trim();
        const normalizedPhone = normalizePhone(data.phone);
        data.address = String(data.address || '').trim();
        if (!isValidDateOnly(data.date_of_birth)) {
            const field = form.elements.namedItem('date_of_birth');
            field.setCustomValidity('Enter a valid date of birth that is not in the future.');
            field.reportValidity();
            field.addEventListener('input', () => field.setCustomValidity(''), { once: true });
            return;
        }
        if (!normalizedPhone) {
            const field = form.elements.namedItem('phone');
            field.setCustomValidity('Enter a valid phone number with 7 to 15 digits.');
            field.reportValidity();
            field.addEventListener('input', () => field.setCustomValidity(''), { once: true });
            return;
        }
        data.phone = normalizedPhone;
        if (data.emergency_contact_phone) {
            const emergencyPhone = normalizePhone(data.emergency_contact_phone);
            if (!emergencyPhone) {
                const field = form.elements.namedItem('emergency_contact_phone');
                field.setCustomValidity('Enter a valid emergency contact phone number.');
                field.reportValidity();
                field.addEventListener('input', () => field.setCustomValidity(''), { once: true });
                return;
            }
            data.emergency_contact_phone = emergencyPhone;
        }
        if (!data.full_name || !data.phone || !data.address) {
            const fieldName = !data.full_name ? 'full_name' : !data.phone ? 'phone' : 'address';
            const field = form.elements.namedItem(fieldName);
            field.setCustomValidity('This field is required.');
            field.reportValidity();
            field.addEventListener('input', () => field.setCustomValidity(''), { once: true });
            return;
        }

        button.disabled = true;
        const originalText = button.textContent;
        button.textContent = 'Adding...';
        data.id = crypto.randomUUID();
        data.version = 1;
        const operationId = crypto.randomUUID();
        try {
            const result = await postPatient(data, operationId);
            if (!result) {
                notify('Patient was not added. No local or server record was changed.', 'info');
                return;
            }
            window.notifyRecordChange?.();
            const returnTo = window.location.pathname === '/patients'
                ? `${window.location.pathname}${window.location.search}`
                : '/patients';
            window.location.assign(
                `/patients/${encodeURIComponent(result.id || data.id)}?returnTo=${encodeURIComponent(returnTo)}`,
            );
        } catch (error) {
            if (!isRetryableNetworkError(error)) {
                console.error('[ADD] Failed:', error);
                notify(error.message || 'Unable to add patient.', 'error', true);
                return;
            }
            try {
                let localMatches = null;
                try {
                    localMatches = await localDuplicateMatches(data);
                } catch (localCheckError) {
                    console.warn('[ADD] Local duplicate check unavailable:', localCheckError);
                }
                if (localMatches?.length) {
                    const prompt = [
                        'Possible matches were found in records stored on this device:',
                        formatDuplicateMatches(localMatches.map((patient) => ({
                            ...patient,
                            reasons: [
                                ...(String(patient.phone || '').trim() === data.phone ? ['phone'] : []),
                                ...(String(patient.full_name || '').trim().toLocaleLowerCase() === data.full_name.toLocaleLowerCase() &&
                                    String(patient.date_of_birth || '').slice(0, 10) === data.date_of_birth
                                    ? ['name_and_date_of_birth']
                                    : []),
                            ],
                        }))),
                        '',
                        'This check is local-only. HealthSys will check again before synchronization. Save this as a separate patient anyway?',
                    ].join('\n');
                    if (!window.confirm(prompt)) {
                        notify('Patient was not added. No local or server record was changed.', 'info');
                        return;
                    }
                }
                await window.db.addLocalPatientAndQueue(data, operationId);
                window.notifyRecordChange?.();
                closeModal('addPatientModal');
                form.reset();
                window.dispatchEvent(new Event('healthsys:queue-updated'));
                notify(
                    localMatches === null
                        ? 'Patient saved on this device. Local duplicate checking was unavailable; HealthSys will check before synchronization.'
                        : 'Patient saved on this device and queued for synchronization. Local duplicate checks are not authoritative; HealthSys will verify before applying it.',
                    'success',
                );
            } catch (queueError) {
                console.error('[ADD] Unable to save offline:', queueError);
                notify('Unable to add the patient or save the change locally. Check available storage and try again.', 'error', true);
            }
        } finally {
            button.disabled = false;
            button.textContent = originalText;
        }
    }

    async function deletePatient(button) {
        const id = button.dataset.id;
        const version = Number(button.dataset.version);
        const operationId = crypto.randomUUID();
        const patientName = button.closest('tr')?.querySelector('[data-label="Name"]')?.textContent.trim() || 'this patient';
        const confirmed = await window.HealthSysUI?.confirmAction(
            `Soft-delete ${patientName}? The record will be retained and can be restored by an administrator.`,
            'Delete patient record'
        );
        if (!confirmed) return;
        if (button.disabled) return;
        button.disabled = true;
        const originalText = button.textContent;
        button.textContent = 'Deleting...';

        try {
            const response = await fetch(`/patients/delete/${encodeURIComponent(id)}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'X-CSRF-Token': document.body.dataset.csrfToken || '',
                },
                body: JSON.stringify({ version, operationId }),
                cache: 'no-store'
            });
            if (!response.ok) {
                const result = await response.json().catch(() => ({}));
                throw new Error(result.error || `HTTP ${response.status}`);
            }
            await window.db.deleteLocalPatient(id);
            window.notifyRecordChange?.();
            window.location.reload();
        } catch (error) {
            if (!isRetryableNetworkError(error)) {
                console.error('[DELETE] Failed:', error);
                notify(error.message || 'Unable to delete patient.', 'error', true);
                return;
            }
            try {
                await window.db.queuePatientDeletion(id, version, operationId);
                window.notifyRecordChange?.();
                button.closest('tr')?.remove();
                window.dispatchEvent(new Event('healthsys:queue-updated'));
                notify('Patient deletion saved on this device and queued for synchronization.', 'success');
            } catch (queueError) {
                console.error('[DELETE] Unable to save offline:', queueError);
                notify('Unable to delete the patient or queue the change locally. Try again when storage is available.', 'error', true);
            }
        } finally {
            button.disabled = false;
            button.textContent = originalText;
        }
    }

    async function initializePatientPage() {
        let localStorageReady = false;
        try {
            localStorageReady = window.db
                ? await window.db.databaseReady?.() !== false
                : false;
            if (localStorageReady && window.db.setCurrentUser) {
                await window.db.setCurrentUser(userId);
            } else if (window.db && localStorageReady) {
                window.db.userId = userId;
            }
        } catch (error) {
            localStorageReady = false;
            console.error('[PATIENTS] Local storage initialization failed.', error?.name || 'DATABASE_ERROR');
        }
        if (!localStorageReady) {
            notify('Offline patient storage is unavailable. Online patient management remains available; offline changes cannot be queued until local storage recovers.', 'error', true);
        }

        try {
            await refreshPatients();
        } catch (error) {
            console.warn('[PATIENTS] Local cache refresh failed; keeping server-rendered records.', error);
        }

        if (localStorageReady && navigator.onLine) {
            try {
                const pendingCount = await window.db.syncQueue.count();
                if (pendingCount > 0) {
                    const result = await window.db.syncPendingData();
                    window.dispatchEvent(new CustomEvent('healthsys:automatic-sync', { detail: result }));
                    if (result.success) await refreshPatients();
                }
            } catch (error) {
                console.error('[PATIENTS] Could not sync pending changes.', error);
            }
        }
    }

    async function downloadPatientCsv(button) {
        const status = document.getElementById('patientExportStatus');
        button.disabled = true;
        if (status) status.textContent = 'Preparing patient export…';
        try {
            const response = await fetch(button.dataset.csvExport, {
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { Accept: 'text/csv' },
            });
            if (!response.ok) {
                const message = (await response.text()).trim();
                throw new Error(message || `Export failed with HTTP ${response.status}.`);
            }
            if (!response.headers.get('Content-Type')?.includes('text/csv')) {
                throw new Error('The server returned an unexpected export format.');
            }
            const count = Number(response.headers.get('X-Exported-Records'));
            if (!Number.isSafeInteger(count) || count < 0) {
                throw new Error('The server did not confirm the exported record count.');
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `healthsys-patients-${new Date().toISOString().slice(0, 10)}.csv`;
            link.click();
            URL.revokeObjectURL(url);
            if (status) status.textContent = `Exported ${count} patient record(s).`;
        } catch (error) {
            if (status) status.textContent = error.message || 'Patient export failed.';
        } finally {
            button.disabled = false;
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        const addForm = document.getElementById('addPatientForm');
        if (addForm) addForm.addEventListener('submit', handleAdd);
        const filterForm = document.querySelector('.patient-filters');
        if (filterForm) {
            filterForm.addEventListener('submit', (event) => {
                const loading = document.getElementById('patientsLoading');
                if (loading) loading.hidden = false;
                const submit =
                    event.submitter || filterForm.querySelector('button[type="submit"]');
                if (submit) submit.disabled = true;
            });
        }
        document.querySelectorAll('[data-csv-export]').forEach((button) => {
            button.addEventListener('click', () => void downloadPatientCsv(button));
        });
        const table = document.getElementById('patientsTable');
        if (table) {
            table.addEventListener('click', (event) => {
                const button = event.target.closest('[data-action="delete"]');
                if (button) deletePatient(button);
                const copyButton = event.target.closest('[data-copy-patient-id]');
                if (copyButton) {
                    void (async () => {
                        try {
                            const patientId = copyButton.dataset.copyPatientId;
                            if (navigator.clipboard?.writeText) {
                                await navigator.clipboard.writeText(patientId);
                            } else {
                                const temporaryField = document.createElement('textarea');
                                temporaryField.value = patientId;
                                temporaryField.setAttribute('readonly', '');
                                temporaryField.style.position = 'fixed';
                                temporaryField.style.opacity = '0';
                                document.body.append(temporaryField);
                                temporaryField.select();
                                const copied = document.execCommand('copy');
                                temporaryField.remove();
                                if (!copied) throw new Error('Clipboard unavailable.');
                            }
                            copyButton.title = 'Patient ID copied';
                            window.setTimeout(() => {
                                copyButton.title = 'Copy full patient ID';
                            }, 1500);
                        } catch (error) {
                            console.error('[PATIENTS] Could not copy patient ID.', error?.name || 'CLIPBOARD_ERROR');
                            notify('The patient ID could not be copied. Its complete value is available in the ID label.', 'error');
                        }
                    })();
                }
            });
        }
        void initializePatientPage();
    });

    window.openModal = openModal;
    window.closeModal = closeModal;
})();
