# HealthSys: Design of an Offline-Capable Patient Management Progressive Web Application with Optimistic Concurrency Control

**Research paper prototype — synthetic evaluation only**

**Author:** [Author name]  
**Affiliation:** [Institution or organization]  
**Date:** 26 September 2026

> **Integrity statement.** This document is a research-style description of the HealthSys software project. Any dataset, workload, count, or outcome in the evaluation section is synthetic and illustrative. It is not a report of a completed user study, clinical deployment, benchmark, or experiment. HealthSys has not been validated for clinical use.

## Abstract

Healthcare workers may need to access patient records when network connectivity is intermittent. This paper presents HealthSys, a web-based patient-management prototype designed to support patient-record operations both online and during temporary disconnection. The application uses a Node.js and Express server, server-rendered EJS views, a MySQL-compatible TiDB database, and browser-side IndexedDB storage managed through Dexie.js. A service worker supports selected offline page and asset access, while a client-side operation queue records patient additions, edits, and deletions for later synchronization.

Offline editing introduces a consistency problem: two clients can edit the same record based on the same old copy and later upload conflicting changes. HealthSys addresses this with optimistic concurrency control using a per-patient integer version. A client submits the version it read; the server applies the change only if the database still has that version, then increments it atomically. A version mismatch is reported as a conflict rather than silently overwriting the newer record. Resolved operations are removed from the local queue while conflicts remain available for follow-up.

The paper describes the system architecture, synchronization protocol, and a reproducible synthetic evaluation plan. Illustrative scenarios show the expected behavior for successful synchronization and competing edits; they are not empirical measurements. The prototype demonstrates a practical architecture for offline-capable record management, while leaving important work—such as conflict-resolution workflows, security hardening, clinical validation, and production operations—for future development.

**Keywords:** offline-first application, progressive web application, patient management, IndexedDB, synchronization, optimistic concurrency control, synthetic evaluation

## 1. Introduction

Reliable network access cannot always be assumed in field, outreach, or temporary-connectivity settings. A client that depends on a live server for every interaction may become unusable during a network interruption. Local browser storage can preserve basic access and allow users to continue entering changes, but those changes must later be reconciled with the server.

This creates two related engineering challenges. First, the user interface should remain usable when a request cannot reach the server. Second, synchronization must not silently overwrite a change made by another client. A timestamp-based “last write wins” approach can be misleading when client clocks differ or when two users edit the same record from stale copies. HealthSys uses a version check at the database write boundary to detect that case.

This paper documents the design of HealthSys, a prototype healthcare-management web application. Its current patient workflow supports viewing records, adding and editing records, soft deletion, local persistence, and later synchronization. Its central consistency mechanism is version-based optimistic concurrency control (OCC): edits proceed without locking a record in advance, but the server accepts an update only if the record has not changed since the client read it.

The contribution is a system description and an explicit synthetic test plan—not a claim of clinical effectiveness or measured system performance. The paper also identifies prototype limitations that should be addressed before any real-world deployment.

## 2. Background and Related Concepts

### 2.1 Offline-capable web applications

Progressive web applications can use browser storage and service workers to provide selected content when the network is unavailable. A service worker can intercept requests and apply a cache strategy, while IndexedDB provides structured client-side persistence. These mechanisms improve availability but do not, by themselves, provide a synchronization protocol or guarantee that cached data is current.

HealthSys uses a service worker for application resources and eligible page responses. Patient records and pending operations are stored separately in IndexedDB. The architecture therefore distinguishes **availability** (the user can access cached application content) from **consistency** (the server and clients agree on the current record state).

### 2.2 Optimistic concurrency control

OCC allows multiple clients to work without holding long-lived locks. At commit time, a client presents the state version on which its change was based. The server compares that expected version with the current database version. If they match, the write succeeds and advances the version; otherwise, the server reports a conflict. This compare-and-update operation is commonly implemented atomically in SQL using a conditional `UPDATE`.

In HealthSys, the `version` field is an integer associated with each patient. It is independent of client wall-clock time, avoiding clock-skew comparisons for patient edit conflicts. The existing `updated_at` timestamp remains useful for audit/display purposes but is not the authoritative token for these patient updates.

## 3. System Architecture

### 3.1 Components

HealthSys follows a browser–server–database architecture:

```text
Browser
  ├── EJS-rendered pages and client-side JavaScript
  ├── Dexie.js / IndexedDB
  │     ├── patients: local patient copies
  │     └── syncQueue: pending ADD / EDIT / DELETE operations
  └── Service worker: selected resources and page responses
             │
             │ HTTPS requests and queued synchronization
             ▼
Node.js + Express server
  ├── Authentication and session middleware
  ├── Patient routes and synchronization route
  └── MySQL2 connection pool
             │
             ▼
MySQL-compatible TiDB database
  ├── users
  ├── patients (including version and soft-delete metadata)
  └── sync_logs
```

The Express server runs on the project host and connects to a TiDB Cloud database. The browser is the client; patient data is not written directly from the browser to the database. The server validates requests and executes parameterized database statements.

### 3.2 Patient data and local queue

The patient record contains an identifier, name, date of birth, gender, phone number, address, and synchronization metadata. The database stores gender values in normalized lowercase form. The user interface formats these values for display. Date-of-birth values are handled as date-only strings for form input, avoiding accidental timezone conversion in the browser.

The Dexie database `healthsysDB` has two stores:

| Store | Purpose |
|---|---|
| `patients` | Locally available patient records, including the server version last observed |
| `syncQueue` | Pending operations with operation type, target store, payload, and client timestamp |

An edit or delete operation carries the version of the record that the client read. An addition starts at version 1. Operations are transmitted to `POST /sync` when synchronization is attempted.

### 3.3 Online and offline behavior

For an online operation, the client sends the operation directly to a patient route. If the operation cannot reach the server because the client is offline or encounters a network failure, the local record is updated and the operation is added to `syncQueue`. When connectivity returns, synchronization submits queued operations to the server.

The service worker provides page and resource caching; it is not the source of truth for patient records. Local patient data is supplied by IndexedDB. This separation matters: a page being available offline does not imply that server-side actions, such as staff administration or reporting, can complete while disconnected.

## 4. Concurrency-Control Design

### 4.1 Version lifecycle

The patient table uses:

```sql
version INT NOT NULL DEFAULT 1
```

Existing patient records receive version 1 when the column is added. A successful patient edit or soft delete increments the version. New records begin at version 1.

For example, suppose two systems read patient `P` at version 7:

1. System A submits an edit with expected version 7.
2. The database still contains version 7, so the update succeeds and sets the version to 8.
3. System B submits a different edit with expected version 7.
4. The database now contains version 8, so System B's conditional update affects no row and is returned as a conflict.

The database comparison and mutation occur together:

```sql
UPDATE patients
SET full_name = ?,
    date_of_birth = ?,
    gender = ?,
    phone = ?,
    address = ?,
    version = version + 1
WHERE id = ?
  AND version = ?;
```

This avoids the unsafe pattern of querying the version, deciding in application code, and then issuing an unconditional update; another writer could change the record between those two operations.

### 4.2 Synchronization response and queue retention

The sync endpoint returns a success count, conflict count, skipped count, resolved operation indexes, and conflict details. The client removes only operations explicitly marked as resolved. Conflicting operations remain in the local queue rather than being discarded along with successful operations.

Conceptually:

```json
{
  "success": true,
  "processed": 1,
  "conflicts": 1,
  "resolvedIndexes": [0],
  "conflictDetails": [
    {
      "index": 1,
      "id": "synthetic-patient-id",
      "reason": "version_mismatch",
      "serverVersion": 8
    }
  ]
}
```

The conflict response preserves evidence that a user’s pending operation was not applied. It does not automatically merge fields or choose a winning client value. A user-facing conflict-resolution workflow remains future work.

### 4.3 Direct online writes

The online edit and delete routes also require an expected patient version. They update only when the supplied version matches and return an HTTP conflict response when it does not. This ensures the same concurrency rule applies whether a change arrives through direct online CRUD or through the offline synchronization endpoint.

## 5. Methodology: Synthetic Evaluation Plan

### 5.1 Purpose

The purpose of the evaluation is to illustrate how OCC should behave under a small set of deterministic multi-client scenarios. It is not a performance benchmark, usability study, or clinical evaluation. No real patient records or real user activity are used.

### 5.2 Synthetic data and workload

For demonstration, consider a generated dataset of 100 fictional patient records with non-identifying placeholder values. Three simulated clients perform 110 operations:

- 10 additions with unique synthetic identifiers;
- 60 sequential edits based on the latest known version;
- 20 competing edit pairs, where both edits in each pair begin from the same version.

This workload is deliberately constructed to exercise version matching and mismatch handling. The counts are illustrative inputs and expected outcomes, not observed results from a test run.

### 5.3 Expected correctness cases

| Case | Synthetic setup | Expected result |
|---|---|---|
| Fresh edit | Client submits the current version | Update is applied; version advances by one |
| Stale edit | Another client has already advanced the version | Update is rejected as a conflict; existing server data remains unchanged |
| Stale delete | Another client edits the record before a queued delete syncs | Delete is rejected as a conflict |
| Independent record edits | Clients edit different patient IDs | Both updates can succeed |
| Offline operation | Client queues an edit and server version has not changed | Queued edit is applied at sync |
| Mixed batch | Some operations are valid and some conflict | Valid operations are resolved; conflicts remain queued |

## 6. Illustrative Synthetic Results

The following table shows the **expected arithmetic for the constructed workload**, not measured system results:

| Operation group | Attempts | Expected applied | Expected conflicts |
|---|---:|---:|---:|
| Unique additions | 10 | 10 | 0 |
| Sequential current-version edits | 60 | 60 | 0 |
| Competing edit pairs (two attempts per pair) | 40 | 20 | 20 |
| **Total** | **110** | **90** | **20** |

Under the stated assumptions, one edit in each competing pair advances the version and the other is rejected. This yields 20 conflicts among 110 operations (18.2%). This percentage is a property of the synthetic scenario design; it must not be interpreted as a conflict rate observed in HealthSys use.

The principal correctness criterion is not a particular conflict percentage. It is that an update based on a stale version does not overwrite the record and that the client retains the unresolved operation for review. The implemented response/queue design is intended to support that criterion. A formal integration test against concurrent database transactions is still needed before treating the behavior as verified under load.

## 7. Discussion

Version-based OCC is appropriate for HealthSys’s current patient CRUD workflow because concurrent edits are expected to be occasional, and holding a database lock while a user edits offline would be impractical. The version token makes a stale write detectable at synchronization time without requiring synchronized client clocks.

The current design uses record-level versions. Consequently, two clients editing different fields of the same patient still conflict. This conservative behavior avoids silently merging potentially related healthcare data, but it may require a user to review and reapply a change. Field-level merge logic could reduce unnecessary conflicts, but would require explicit rules, auditability, and careful evaluation.

Keeping conflicts in the queue avoids data loss, but it also means the user needs a clear next step. Repeatedly resubmitting an unchanged stale operation will continue to conflict. A complete workflow should show the server’s current record alongside the local pending version and let an authorized user discard, reapply, or deliberately merge the change. Such a workflow should preserve an audit trail.

The project also uses synthetic-friendly date handling, lowercase database gender values with presentation formatting, and HTML escaping when rendering locally stored patient values. Those controls are relevant because offline data can later be rendered before it has passed through the server’s normal request path.

## 8. Limitations and Threats to Validity

1. **Synthetic evaluation only.** The paper’s dataset and workload are illustrative. No benchmark, clinical trial, user study, or independent code audit is reported.
2. **Prototype deployment model.** The application is hosted by a laptop-based Node/Express server and uses a cloud-hosted MySQL-compatible database. Availability, backups, monitoring, scaling, and disaster recovery are not established by this design description.
3. **Conflict resolution is incomplete.** The server reports conflicts and the client preserves them, but the application does not yet provide a full comparison-and-resolution interface.
4. **Multiple offline edits to one record.** A client that queues several edits to the same patient while offline can create multiple operations based on the same initial version. After the first operation advances the version, later operations may conflict. Queue coalescing or sequential version-aware replay should be designed and tested.
5. **Deletion semantics.** Deletion is implemented as a soft delete. The application must define how a concurrent edit versus delete should be presented to a user and audited.
6. **Authentication and authorization.** Offline page caching does not provide fresh server-side authorization while disconnected. Cached pages should be treated as sensitive, and the application requires a security review and appropriate device controls before handling real patient information.
7. **Clinical suitability.** HealthSys is a software project, not a validated electronic health record or clinical decision-support system. No claims are made about regulatory compliance, patient safety, or suitability for medical care.

## 9. Privacy and Ethical Considerations

The synthetic evaluation described here must use fictional records only. Real patient information should not be added to test fixtures, screenshots, logs, or research artifacts. Offline browser storage creates additional exposure if a device is shared, lost, or compromised; production use would require a documented threat model, appropriate access controls, secure session configuration, device-level protection, data-retention policies, and an incident-response process.

Any future evaluation involving people or real healthcare data would require appropriate institutional, legal, and organizational review before data collection. This paper does not claim that such review has occurred.

## 10. Conclusion

HealthSys demonstrates an offline-capable patient-management architecture using Express, EJS, TiDB/MySQL, Dexie.js, IndexedDB, and a service worker. Its synchronization queue allows patient operations to be retained locally during connectivity failures. A per-record integer version provides a deterministic mechanism for detecting concurrent stale updates: the server applies a mutation only if the client’s expected version matches the current database version.

The design prevents silent last-writer-wins overwrites for version-checked patient edits and deletes, while preserving conflicts for follow-up. The next engineering priorities are an explicit conflict-resolution interface, handling of multiple queued edits to one record, automated concurrent integration tests, and a security and operational review. The synthetic scenarios in this draft illustrate expected behavior only and are not evidence of measured performance or clinical readiness.

## References

[1] L. Lamport, “Time, Clocks, and the Ordering of Events in a Distributed System,” *Communications of the ACM*, vol. 21, no. 7, pp. 558–565, 1978. doi: 10.1145/359545.359563.

[2] W. Vogels, “Eventually Consistent,” *Communications of the ACM*, vol. 52, no. 1, pp. 40–44, 2009. doi: 10.1145/1435417.1435432.

[3] M. Kleppmann, *Designing Data-Intensive Applications: The Big Ideas Behind Reliable, Scalable, and Maintainable Systems*. Sebastopol, CA: O’Reilly Media, 2017.

[4] World Wide Web Consortium (W3C), “Service Workers,” W3C Specification. Available: https://www.w3.org/TR/service-workers/

## Project implementation references

The system description is based on the project implementation, including:

- `server/app.js` — Express application, middleware, and route setup.
- `server/routes/patients.js` — online patient CRUD endpoints.
- `server/routes/sync.js` — queued operation processing and version checks.
- `server/public/js/db.js` — Dexie/IndexedDB stores and background synchronization.
- `server/public/js/patients.js` — patient interface, local CRUD, and queued operations.
- `server/public/service-worker.js` — application resource and page caching.
- `server/migrate_concurrency.js` — patient version-column migration.
