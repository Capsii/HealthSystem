# HealthSys

**An offline-capable patient-management web application built with
Express, EJS, and MySQL-compatible databases.**

HealthSys brings patient records, staff access, appointments, clinical
encounters, reporting, and recovery tools into one web application. It
can be installed as a Progressive Web App (PWA), with a local patient
workspace for selected workflows when the network is unavailable.

> **Important:** Offline support is limited. Patient records stored in
> browser storage are not encrypted by this application. Use synthetic
> data for demonstrations and testing, and do not use a shared or
> unmanaged device for clinical information.

## Contents

-   [Features](#features)
-   [Technology and architecture](#technology-and-architecture)
-   [Requirements](#requirements)
-   [Installation on Windows](#installation-on-windows)
-   [Configuration](#configuration)
-   [Run and test](#run-and-test)
-   [Synthetic demo data](#synthetic-demo-data)
-   [PWA and offline behavior](#pwa-and-offline-behavior)
-   [Security notes](#security-notes)
-   [Troubleshooting](#troubleshooting)
-   [Known limitations](#known-limitations)
-   [Project documentation](#project-documentation)

## Features

### Patient management

-   Search, combined filters, sorting, and server-side pagination.
-   Patient profiles and clinical details, including emergency contacts,
    allergies, medical history, and medications.
-   Soft deletion and restoration.
-   Visit and encounter history, consultation details, treatment plans,
    vital signs, author attribution, and activity history.

### Staff and administration

-   Role-based access and administrator-managed staff accounts.
-   Session versioning and CSRF protection.
-   Appointment management, reports, CSV import/export, security audit
    views, and server backup/restore tools.

### Offline patient workspace

-   A service-worker-backed static app shell and offline fallback.
-   Previously stored patient snapshots available in the local
    workspace.
-   Supported patient create/edit/delete operations queued locally for
    later synchronization.
-   Stable operation IDs, version checks, retries, and conflict review
    for queued patient changes.

**Offline boundaries:** Dashboard and Reports may show device-local or
stale snapshots. Offline Staff and Data Recovery pages are
informational. Visits, encounters, appointments, staff changes, CSV
operations, server backup/restore, and other protected server actions
require connectivity. Offline changes must be synchronized before they
can be considered confirmed on the server.

## Technology and architecture

-   **Server:** Node.js, Express 5, EJS, and server-side sessions.
-   **Database:** MySQL-compatible database, including TiDB.
-   **Browser:** JavaScript and CSS, with Dexie/IndexedDB for local
    patient snapshots and the account-scoped synchronization queue.
-   **PWA:** Service worker and Cache Storage for the static application
    shell and offline fallback pages.
-   **Synchronization:** `/sync` authenticates queued operations, checks
    record versions and idempotency, and acknowledges successful
    operations before the browser removes them from the queue.

``` mermaid
flowchart LR
  subgraph Device["Browser or installed PWA"]
    UI["EJS views, JavaScript, CSS"]
    SW["Service worker: static shell"]
    IDB["Dexie / IndexedDB: patient snapshots and sync queue"]
    UI <--> IDB
    SW -. "offline navigation" .-> UI
  end

  subgraph Server["HealthSys server"]
    ROUTES["Express routes"]
    AUTH["Session, role, and CSRF checks"]
    LOGIC["Validation and data access"]
    SYNC["/sync: idempotency and version checks"]
    AUDIT["Patient activity, visit history, security audit"]
    ROUTES --> AUTH --> LOGIC
    ROUTES --> SYNC
    LOGIC --> AUDIT
    SYNC --> AUDIT
  end

  DB[("MySQL / TiDB")]
  UI -->|"online requests"| ROUTES
  LOGIC --> DB
  SYNC --> DB
  AUDIT --> DB
  IDB -->|"after connectivity and session verification"| SYNC
```

### Request and synchronization flow

**Online:** The browser requests a page or API endpoint. Express checks
the session and permissions, validates the request, and reads or updates
the database. Relevant actions are recorded by the application's
activity or audit mechanisms.

**Offline:** The patient workspace uses data already stored in
IndexedDB. Supported changes are saved locally and marked as pending.
When connectivity returns, the app verifies the server session and sends
queued operations to `/sync`. The server applies or rejects each
operation; only successful acknowledgements remove items from the queue.
Stale changes remain available for review.

## Requirements

The following versions were used for verification in the delivery
environment; other versions have not been verified here.

-   Node.js **24.x**
-   npm **11.x**
-   A MySQL-compatible database supporting InnoDB, transactions, and the
    SQL features used by the migrations.
-   PowerShell for the commands in this guide.
-   The database TLS CA file expected by the application at
    `server/cert/isrgrootx1.pem`.

The configured test endpoint reported TiDB Serverless v8.5.3 with MySQL
compatibility version 8.0.11. Check your own database service and
version before deployment.

## Installation on Windows

Run the following commands from the project root.

### 1. Install dependencies

``` powershell
npm ci
```

### 2. Configure environment variables

``` powershell
Copy-Item .env.example .env
```

Edit `.env` and replace every placeholder. Do not commit `.env` or share
its secrets.

### 3. Provision the database

Create a dedicated database and application user through your database
administrator's approved process. Configure `DB_HOST`, `DB_PORT`,
`DB_USER`, `DB_PASSWORD`, and `DB_NAME` in `.env`.

For a **new development or demo database**, apply the base schema to the
selected database:

``` powershell
mysql --host $env:DB_HOST --port $env:DB_PORT --user $env:DB_USER --password --database $env:DB_NAME --ssl-mode VERIFY_IDENTITY --ssl-ca .\server\cert\isrgrootx1.pem --execute 'source .\database\base-schema.sql'
```

The MySQL CLI prompts for the database password. This script creates the
base `patients` and `users` tables expected by the additive migrations;
it does not create the database or its user. Review existing schemas
before applying it to an existing deployment.

`server/setup_db.js` is a legacy local helper that creates only a
minimal patients table using `LOCAL_DB_*`. It is not the recommended
application bootstrap process.

### 4. Apply migrations

``` powershell
npm run migrate
```

Migrations run in this order:

1.  `001_patient_management`
2.  `002_staff_security`
3.  `003_security_audit`
4.  `004_sync_idempotency`
5.  `005_sync_logs`
6.  `006_appointments`
7.  `007_patient_encounters`
8.  `008_patient_query_indexes`

Successful migration IDs are recorded in `schema_migrations`. **Back up
the database before production migrations.** Some MySQL DDL operations
commit outside a transaction, and this project does not provide
automatic down migrations.

### 5. Generate a development certificate and start the server

``` powershell
node server/generate_dev_cert.js
npm start
```

The certificate generator creates ignored, self-signed development
certificate files and refuses to overwrite existing files. By default,
the server listens on:

-   HTTP: `http://localhost:3000`
-   HTTPS: `https://localhost:3443`

Open `http://localhost:3000/login`. The browser may warn about the
self-signed HTTPS certificate during development.

### 6. Create the first administrator

Set a strong, temporary `INITIAL_ADMIN_PASSWORD` in the server
environment, then run:

``` powershell
node createAdmin.js
```

The initial account username is `admin`. Remove the temporary password
from the environment after account creation.

For production, set `NODE_ENV=production`, configure
`HTTPS_REDIRECT_ORIGIN`, and set `TRUST_PROXY` only to the actual
trusted proxy configuration. Terminate TLS at a trusted production
proxy; do not use the development certificate listener as a production
TLS setup.

## Configuration

See [`.env.example`](./.env.example) for the supported variable names
and placeholder values.

Required application variables:

-   `SESSION_SECRET`
-   `DB_HOST`
-   `DB_PORT`
-   `DB_USER`
-   `DB_PASSWORD`
-   `DB_NAME`

Production also requires `HTTPS_REDIRECT_ORIGIN`. Configure
`TRUST_PROXY` only when the deployment uses a trusted proxy.

`INITIAL_ADMIN_PASSWORD`, `RESTORE_ADMIN_PASSWORD`, and
`DEBUG_USER_PASSWORD` are operation-specific secrets. Set them only when
needed and remove them afterward. `LOCAL_DB_*` is used by the legacy
local setup helper, not by the main application database pool.

## Run and test

### Unit tests and code checks

``` powershell
npm test
npm run lint
npm run format:check
```

### Integration and performance tests

Integration tests are destructive. Run them only against a confirmed
disposable database named `healthsys_test`, never against `project` or a
shared database.

``` powershell
$env:DB_NAME = 'healthsys_test'
$env:ALLOW_DESTRUCTIVE_INTEGRATION_TESTS = 'true'

npm run test:integration
npm run test:performance

Remove-Item Env:ALLOW_DESTRUCTIVE_INTEGRATION_TESTS -ErrorAction SilentlyContinue
Remove-Item Env:DB_NAME -ErrorAction SilentlyContinue
```

Review the selected database and its contents before running tests. The
performance test creates synthetic patients and visits, checks
paginated/filter queries and query plans, then removes its generated
rows. Timing depends on database and network conditions and should not
be treated as a production guarantee.

`npm run test:release` runs unit and guarded integration tests; it does
not include `test:performance`.

## Synthetic demo data

Use a separate, migrated `healthsys_demo` database. **Never seed or
reset the production `project` database.**

The demo seed creates 24 fictional patients, two synthetic visits and
vital readings per patient, plus demo administrator and staff accounts.
Passwords are supplied at runtime; no demo password is embedded in
source.

``` powershell
$env:DB_NAME = 'healthsys_demo'
$env:ALLOW_DEMO_SEED = 'true'

$secureAdmin = Read-Host 'Demo administrator password' -AsSecureString
$env:DEMO_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $secureAdmin).Password

$secureStaff = Read-Host 'Demo staff password' -AsSecureString
$env:DEMO_STAFF_PASSWORD = [System.Net.NetworkCredential]::new('', $secureStaff).Password

npm run seed:demo -- --seed

Remove-Item Env:DEMO_ADMIN_PASSWORD, Env:DEMO_STAFF_PASSWORD, Env:ALLOW_DEMO_SEED, Env:DB_NAME -ErrorAction SilentlyContinue
```

Re-running the seed is designed to be idempotent: it does not overwrite
existing demo account passwords or edit existing synthetic records.

To remove the reserved synthetic demo records, set both
`ALLOW_DEMO_SEED=true` and `ALLOW_DEMO_RESET=true`, confirm
`DB_NAME=healthsys_demo`, and run:

``` powershell
npm run seed:demo -- --reset
```

Reset removes deterministic demo IDs and linked records. Do not use it
in a database containing records that must be retained.

## PWA and offline behavior

1.  Open HealthSys through HTTPS or localhost.
2.  Sign in while online and allow the service worker to install.
3.  Visit Patient Management online so the app can store the available
    patient snapshot locally.
4.  Disconnect the network and open the supported offline patient
    workspace.
5.  When reconnecting, review pending operations and confirm that
    synchronization completes.

The offline workspace can display only records already stored on that
device. Supported patient create/edit operations and administrator-only
delete operations can be queued locally. Pending changes are **not yet
confirmed on the server**.

Offline access requires an established, unexpired local account context
and working browser storage. It does not replace server-side
authorization. Do not clear site data, reinstall the PWA, or switch
devices while changes are pending.

For exact limitations and recovery steps, read
[`docs/offline-and-recovery.md`](./docs/offline-and-recovery.md).

## Security notes

-   Never commit `.env`, credentials, tokens, private keys, or real
    patient records.
-   Use synthetic data for screenshots, demonstrations, tests, and
    performance experiments.
-   Browser-local clinical data and exported offline-backup JSON are
    **not encrypted by this application**.
-   Do not use shared or unmanaged devices for clinical data.
-   Do not manually delete IndexedDB entries or clear browser storage
    while synchronization is pending.
-   Back up the database before production migrations or recovery
    operations.
-   Server backups and device-local offline exports are different
    recovery mechanisms. Follow [`SECURITY.md`](./SECURITY.md) and
    rehearse recovery in an isolated test environment.

## Troubleshooting

  ------------------------------------------------------------------------
  Problem                             What to check
  ----------------------------------- ------------------------------------
  Server fails to start               Confirm required `.env` values,
                                      database connectivity and grants,
                                      and the TLS CA file path.

  Migration reports missing base      Provision compatible `patients` and
  tables                              `users` tables before running
                                      migrations.

  Development certificate is missing  Run
                                      `node server/generate_dev_cert.js`
                                      after installing dependencies.

  Service worker does not install     Use HTTPS or localhost, confirm
                                      browser storage is available, and
                                      reload after installation.

  Offline patient workspace is        Reconnect and sign in to
  unavailable                         re-establish local access. A
                                      server-confirmed `401` invalidates
                                      local context; a temporary network
                                      failure should not.

  Synchronization fails or reports a  Keep the local queue, reconnect,
  conflict                            verify the account, and use the
                                      provided retry/conflict actions. Do
                                      not assume pending changes reached
                                      the server.

  Backup or restore is needed         Follow `SECURITY.md`. Restore is
                                      restricted to a fresh database and
                                      requires explicit
                                      preview/confirmation. Practise only
                                      in a separate test database.
  ------------------------------------------------------------------------

## Known limitations

-   The offline patient list reads all patient snapshots stored on the
    device; local search is not server-side pagination and may be slow
    for large local datasets.
-   Browser-local clinical data and exported offline-backup JSON are not
    encrypted by this application.
-   While disconnected, the application cannot immediately detect
    server-side account revocation.
-   Visits, appointments, staff mutations, server reports, CSV/recovery
    operations, and server backup/restore require connectivity.
-   Offline appointment/visit editing and automatic merging of
    conflicting clinical edits are not provided.
-   Automatic schema rollback is not provided.
-   Production proxy configuration, multi-instance behavior,
    device-specific PWA persistence, target database compatibility, and
    backup restoration must be verified in the deployment environment.

### Delivery checks to revisit

The recorded delivery environment had three high advisories in
development-only `nodemon`/`braces`/`chokidar` dependencies;
`npm audit --omit=dev` reported zero at that time. Re-run the audit
before release and review compatibility before applying major-version
changes.

At that verification, `npm run format:check` also reported existing
formatting differences in `server/patient_repository.js` and
`server/migrate.js`. These should be addressed separately without mixing
unrelated changes into a release.

## Project documentation

-   [Offline limitations and recovery
    procedures](./docs/offline-and-recovery.md)
-   [Offline demonstration and recording
    checklist](./docs/demo-recording-checklist.md)
-   [Security, authorization, backup, and recovery notes](./SECURITY.md)

The demonstration checklist describes a procedure; it is **not proof
that a real device-level offline synchronization recording has been
completed**. Record the actual browser/device, database environment, and
observed results during release verification.
