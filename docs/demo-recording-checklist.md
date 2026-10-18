# Offline-to-online demonstration and recording checklist

This is a manual procedure, not a claim that a recording or end-to-end device demonstration has already been completed. All data shown must come from the synthetic `healthsys_demo` database and must be visibly identified as synthetic. Never show credentials, cookies, database endpoints, real patient data, or unredacted browser storage.

## Prepare

1. Complete the [README setup](../README.md) using `healthsys_demo`, the synthetic seed, and demo-only staff passwords.
2. Start the application and sign in as `demo-clinician` (or `demo-admin`) with the password supplied when seeding. Use a dedicated browser profile/device with no real data or saved credentials.
3. Confirm the page is `http://localhost:3000` or a trusted HTTPS origin and that the service worker is active. In DevTools Application/Storage, confirm the HealthSys Cache Storage shell and the Dexie/IndexedDB patient store exist. Do not capture the contents of clinical records in DevTools.
4. Open Patient Management while online so its patient-list refresh stores snapshots locally. The offline workspace must list the seeded `SYNTHETIC DEMO` records before disconnecting.
5. Start a screen recording and capture the browser/application only. Hide password fields, browser profile identity, developer console, network request headers, and database tools.

## Demonstration sequence

1. **Online baseline:** show the synthetic patient list, one synthetic patient profile and visit history, and the connected status.
2. **Disconnect:** use the browser's network emulation/offline control or disconnect this demo device while leaving the server/database available. Record which method was used. Do not stop the server; the demonstration is of client-offline behavior.
3. **Reload offline:** reload `/patients`. Confirm the service worker serves the offline patient workspace, that locally stored synthetic records remain visible, and that visits/appointments are not represented as available offline.
4. **Local operation:** add one clearly synthetic patient with unique synthetic name/phone details. If demonstrating edit instead, edit a seed patient and identify the record as synthetic. Do not enter real clinical information.
5. **Local persistence/status:** show the local status as pending/not confirmed. Reload the offline workspace once and confirm the row/queue still exists. If local storage fails, stop and record that failure; do not claim a save.
6. **Reconnect:** restore this device's network. Wait for the online session check, or sign in again if required. Use **Sync pending changes** when available.
7. **Verify:** show the app's confirmed synchronization status. In the isolated `healthsys_demo` database, verify the unique synthetic patient ID/phone and its activity count with an authorized, read-only query. Do not include database credentials or unrelated rows in the recording.
8. **Retry/idempotency:** only if a real retry is available from the UI, retry that same queued operation and verify patient/activity counts do not increase. Do not fabricate a queue state, replay a different operation, or label a new operation as a retry. If the successful operation is already acknowledged and removed so the UI offers no same-operation retry, mark this recording step **unverified**; rely on the guarded integration idempotency tests as separate evidence.
9. **Finish:** show no outstanding queue state or show the exact remaining conflict/failure. Stop recording and store it only in approved, access-controlled storage.

## Recording evidence checklist

- [ ] Demo database name confirmed as `healthsys_demo`; dataset seeded by `npm run seed:demo -- --seed`.
- [ ] Browser, version, origin, service-worker status, and offline method recorded without secrets.
- [ ] Synthetic records present in local IndexedDB before disconnect.
- [ ] Offline reload and local add/edit visibly succeeded.
- [ ] Local pending status survived a reload.
- [ ] Network restored; session reverified; actual application sync ran.
- [ ] Server row/activity verified in `healthsys_demo`.
- [ ] Same-operation retry/idempotency result recorded, or explicitly marked unverified with reason.
- [ ] Final queue state, errors/conflicts, and any unverified step documented.
- [ ] Recording reviewed for credentials, cookies, database details, real data, and sensitive logs.

## Result for this repository delivery

No browser/device recording or actual offline-to-online demonstration is asserted by this document. Until the checklist is completed in a browser against the isolated demo database, every device-level result remains unverified. Automated tests and the seed utility are not substitutes for the recording.
