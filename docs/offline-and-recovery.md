# Offline limitations and recovery

This guide documents the current browser implementation. Offline storage is sensitive and is not encrypted by HealthSys. Use a managed device/browser profile with OS disk encryption and a screen lock. The local access context is a convenience for an established profile, not a replacement for server authorization.

## What works offline

| Area                                | Offline behavior                                                                                                                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static shell                        | The service worker precaches versioned CSS, JavaScript, the manifest/icons, an offline patient workspace, and a shared portal. It does not cache authenticated HTML or clinical API responses. Installation requires HTTPS or localhost.                       |
| Patient Management                  | `/patients` falls back to the local workspace. It displays only patient snapshots already in this account's IndexedDB on this device; the local list is not paginated and may be stale. Staff/admin can add and edit locally; only admin can queue a deletion. |
| Dashboard                           | The offline portal shows local counts/queue information and a timestamped account-scoped server-metrics snapshot if one exists. It is not a live dashboard.                                                                                                    |
| Reports                             | The offline portal may show a partial summary derived from the locally stored patient snapshot. It does not apply server report filters or represent the full database.                                                                                        |
| Staff and Data Recovery             | Informational fallback only. Staff administration, CSV, server backup, restore, and audit queries require connectivity.                                                                                                                                        |
| Visits, encounters, appointments    | Online only. Visit history, consultation notes, treatment plans, vital signs, and appointment operations are not stored in the offline queue.                                                                                                                  |
| Authentication and protected writes | Every server action still requires a valid server session, authorization, and CSRF checks. Local edits are not server-confirmed until `/sync` acknowledges them.                                                                                               |

The local offline-access context is recorded after a rendered signed-in page and expires eight hours after verification. A server-confirmed unauthenticated response clears that context; network timeouts and temporary server errors do not prove the session expired. An account revoked while disconnected cannot be checked until reconnecting or local access expires.

## Storage and synchronization lifecycle

- Dexie/IndexedDB contains per-account patient snapshots and a durable patient-operation queue. `localStorage` contains the short-lived account context and sync status metadata. Cache Storage contains static resources and fallback pages, not patient API responses or authenticated pages.
- Online patient listing refreshes local snapshots. Offline operations are written locally before being displayed as saved-on-device/pending. Queue records retain an owner ID, operation type, stable operation ID, expected record version, status, and retry metadata.
- Once online, synchronization checks the current server session and sends queued changes to `/sync`. Server authorization is authoritative. Successful or already-applied acknowledgements remove only the corresponding operations. Retryable network/server failures retain operations for retry; validation failures and stale-version conflicts stay available for review.
- Conflicts preserve local and current-server data. A user must explicitly choose/rebase changes; HealthSys does not silently merge stale clinical changes. Appointment and visit changes are not part of this process.
- The client limits one synchronization batch to 500 operations. Remaining operations stay queued for later batches.

## Recognizing state

The offline workspace labels a record as **Stored locally**, **Change queued · not confirmed**, or **Deletion queued · not confirmed**. Queue counts distinguish pending, processing, failed, and conflicts. The interface reports synchronization confirmed only after a valid server response; an error leaves operations queued. Dashboard sync metadata shows the last attempt/outcome when available. Do not treat a local save, a successful file export, or a service-worker page load as proof of server synchronization.

## Recovery procedures

### Server restart or database outage

1. Keep the browser profile and its local storage intact. A server restart does not itself clear IndexedDB or the queue.
2. Check server/database availability through the normal operations channel without copying clinical contents into logs or tickets.
3. Reconnect and sign in with the account that owns the queued operations. If sign-in fails, resolve server/authentication availability first; do not transfer or replay the queue under another account.
4. Retry synchronization from the offline patient workspace after the server is available. Review conflicts/validation failures; verify expected records through authorized HealthSys screens or database procedures.

### Interrupted or failed synchronization

The queue uses stable operation IDs and server-side idempotency/version checks so a retry can be recognized. An interruption may leave an operation pending or failed locally even if the server committed before the response was lost. Retry through the application; do not create a second patient manually to compensate. The server acknowledgement and patient/activity records are authoritative. A stale-version conflict requires explicit review.

### Browser storage unavailable, full, or damaged

HealthSys surfaces IndexedDB open/write errors and does not intentionally delete/recreate the database to recover. If local save fails, do not assume the change was stored. Stop making additional offline changes, preserve the browser profile/device, and contact the HealthSys administrator. If the database still opens, use the Dashboard's **local offline backup** export and store the file securely; it can contain patient snapshots and unsynchronized clinical operations and is not encrypted.

If local storage is corrupted or inaccessible, preserve the browser profile and any prior offline backup. Do not clear site data, reinstall, switch devices, run browser cleanup, or use developer tools to delete databases while pending work may exist. If no usable backup exists, recovery may require specialist browser/device support; the application cannot reconstruct data that never reached the server.

### Pending changes before browser/device changes

1. Reconnect and sign in as the owning account.
2. Synchronize until the queue reports no pending/processing/failed/conflict items. Resolve conflicts explicitly.
3. Verify important records on the server.
4. If synchronization cannot complete but IndexedDB is available, export the account's local offline backup to approved encrypted storage. Keep the original browser profile too; export does not sync or protect the JSON file.
5. On recovery/import, use the same account ID. Local import merges records and operation IDs without replacing existing entries; imported operations still require online synchronization.

### Deployment or migration failure

Take a database snapshot before production migrations. Migrations are forward-only and MySQL DDL may commit independently. If a deployment/migration fails, retain logs without clinical payloads, stop further schema changes, and follow the deployment rollback/snapshot procedure with the database administrator. Do not run a development bootstrap or destructive test against production. Test restore procedures only in a separate fresh database.

## Backup and restore boundaries

- **Server backup:** Admin-only Data Recovery export contains server patient/visit/activity/audit/sync data and safe staff metadata; it does not contain password hashes or pending IndexedDB operations. Protect it as sensitive clinical data.
- **Local offline backup:** Dashboard export contains only the selected account's device-local snapshots and pending operations. It is not encrypted and is separate from server backup.
- **Server restore:** The route accepts restore only into an eligible fresh database with a single temporary active admin and required clinical/sync/audit tables empty. Preview the backup and target first, set a strong temporary `RESTORE_ADMIN_PASSWORD`, explicitly confirm `RESTORE`, verify the restored counts/relationships, reset restored staff passwords, and remove the temporary secret.

Follow the fuller [security and server recovery procedure](../SECURITY.md). A server backup cannot recover changes that never synchronized or were not included in a separately exported local backup.
