# ASI Database Node API

An open-source multi-tenant API foundation for the Arybit Super Intelligence ecosystem. This repository is not represented as a production-ready commercial database platform. Azure deployment, HTTPS health verification, SQLite persistence, and recovery have not been verified against live Azure infrastructure.

## Implemented and locally verified

- Node.js 24 LTS and Express API.
- SQLite persistence, WAL mode, busy timeout, foreign-key enforcement, and ordered SQL migrations.
- Transactional initialization, session/key writes, tenant resource writes, and associated audit records.
- Password-hashed administrator provisioning with no built-in default credentials.
- Session expiry, API-key revocation and ownership checks, read-only API-key enforcement, and tenant-aware resource access.
- Atomic monthly usage reservations and metering for successful tenant project/database catalog reads and writes; monthly allowances are plan-configured and overridable.
- Tenant usage API and dashboard with remaining quota, period usage, threshold notifications, and recent usage history.
- Stripe subscription checkout and billing-portal links plus signature-verified, idempotent subscription webhooks that update plan entitlements.
- AES-256 encrypted SQLite backup and integrity-checked restore into a new isolated directory.
- Azure Bicep template and deploy script that tests, packages production dependencies, configures the app, deploys the artifact, and checks remote readiness when explicitly authorized.

## Not implemented or not verified

- Live Azure deployment, HTTPS/DNS validation, Key Vault integration, managed-identity permissions, or Azure backup storage configuration.
- Multi-instance or high-availability database operation. SQLite on App Service is limited to one app instance; do not scale this app horizontally.
- Provisioning of actual MySQL, MariaDB, or PostgreSQL servers. Database records currently describe API resources; they do not create database servers.
- A real database query endpoint. Metered project/database catalog API calls are not physical SQL operations against tenant databases; bulk weighted billing is not implemented.
- Email delivery for usage alerts, email configuration, paid overages, automatic plan upgrades, storage quota controls, connection limits, API-rate limits, or external audit export.
- Live Stripe API/webhook verification or Stripe account/price configuration. Stripe test coverage uses a test-signature verifier and stubbed outbound API calls.
- Automatic database schema rollback or a production restore-in-place workflow.

## Local setup

Requires Node.js 24 LTS and npm. First install dependencies and configure an initial administrator and a persistent local database path:

```bash
npm ci
export ADMIN_USERNAME='platform-admin'
read -r -s -p 'Choose an initial administrator password (at least 16 characters): ' ADMIN_PASSWORD
printf '\n'
export ADMIN_PASSWORD
export ASI_DB_PATH="$PWD/.data/asi-database.sqlite"
npm start
```

A fresh database will refuse to initialize if `ADMIN_USERNAME` and `ADMIN_PASSWORD` are not configured. Use a unique, randomly generated password and a secret manager in deployed environments; do not commit credentials or put them in scripts or shell history. Existing databases retain their provisioned users; changing the bootstrap environment variables does not reset an existing password.

The local database is created under `.data/`. Back it up before deleting that directory. Set `ASI_SEED_DEMO_DATA=true` only for local demonstrations; demo tenant/project/database rows and the optional `TENANT_ADMIN_USERNAME` / `TENANT_ADMIN_PASSWORD` account are not created by default. Those optional tenant-admin credentials must both be set and the password must be at least 16 characters.

Run tests:

```bash
npm test
```

Check health/readiness after starting the API:

```bash
curl --fail http://localhost:3000/health
curl --fail http://localhost:3000/api/v1/ready
```

## API overview

- `GET /health` and `GET /api/v1/health`
- `GET /api/v1/ready`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/keys` and `POST /api/v1/auth/keys/revoke`
- `GET|POST /api/v1/tenants`
- `GET|POST /api/v1/projects`
- `GET|POST /api/v1/databases`
- `GET /api/v1/usage?tenantId=<id>[&period=YYYY-MM|YYYY-MM-DD]`
- `POST /api/v1/billing/checkout` and `POST /api/v1/billing/portal`
- `POST /api/v1/billing/webhook` (Stripe signature required)
- `GET /api/v1/metrics` and `GET /api/v1/audit` (administrator only)
- `GET /openapi.json`

SQLite migrations are versioned in [`src/migrations/`](./src/migrations/). The migration ledger is updated transactionally, and writes to resource tables and their audit entries use transactions. This SQLite implementation is intended for a single application instance, not as a substitute for a managed multi-node relational database.

## Usage quotas and Stripe subscriptions

One billable operation is one successful (`2xx`) request to a tenant-scoped `GET` or `POST` on `/api/v1/projects` or `/api/v1/databases`. A cross-tenant listing is charged once per tenant included in that request. Health, login/authentication, tenant administration, billing, usage, exports, and internal maintenance are not metered. The current API stores database-resource metadata only; these counters are not yet physical tenant SQL reads/writes. Bulk requests are not supported as database operations and are not weighted.

The included-operation defaults below are **proposed SaaS defaults**, not previously approved commercial settings:

| Plan | Included operations per period |
| --- | ---: |
| Starter | 100,000 |
| Pro | 1,000,000 |
| Growth | 10,000,000 |

Override the quotas at startup with valid JSON. All three plans must remain configured:

```bash
export ASI_PLAN_QUOTAS='{"starter":{"monthlyIncludedOperations":100000},"pro":{"monthlyIncludedOperations":1000000},"growth":{"monthlyIncludedOperations":10000000}}'
export ASI_USAGE_GRACE_PERIOD_SECONDS=3600
```

Periods without an active Stripe subscription use UTC calendar months. For active monthly Stripe subscriptions, the reset period follows the verified subscription cycle start and end received in the webhook; stale/missing cycle data fails closed rather than silently resetting a quota. The default grace period is one hour and is configurable in seconds. Usage continues to be recorded during grace; after the grace deadline, new billable requests receive `429 usage_limit_exceeded`. A new period has a fresh counter while prior usage events remain queryable.

An atomic SQLite reservation prevents simultaneous requests from racing past a quota when grace is zero; with grace enabled, requests during the explicit grace interval are allowed and counted. The usage API returns the allowance, period, current and remaining operations, grace deadline, notification events, and recent operation history. At 80% and 100%, one durable dashboard notification per threshold and plan is created. The current UI shows these events, but the state explicitly remains `dashboard_pending_email_not_configured`: no email delivery provider is configured or represented as working.

Stripe configuration requires `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_GROWTH`, and an HTTPS `PUBLIC_APP_URL` (HTTP localhost is accepted for local testing). Configure monthly recurring Stripe prices and subscribe the webhook endpoint to `customer.subscription.created`, `.updated`, and `.deleted`. Checkout accepts server-configured price IDs only and an `Idempotency-Key`; only authorized tenant administrators can manage billing. Subscription state changes are accepted only with Stripe's signed raw-body webhook, mapped by configured price ID, transactionally audited, and deduplicated by Stripe event ID. Older events do not overwrite newer subscription state. Paid overages and automatic upgrades are not enabled.

For Azure billing, provide all five Stripe variables from a secure environment before running the deployment script; it rejects partial Stripe configuration and writes supplied values as Web App settings. `PUBLIC_APP_URL` is optional there and defaults to the deployed `https://<web-app-name>.azurewebsites.net` URL. If Stripe variables are omitted, the application deploys without checkout or webhook processing configured.

Stripe tests use a test-mode SDK webhook signature and stubbed checkout/portal calls; they make no Stripe network calls and do not verify a live merchant account, webhook delivery, tax/payment collection, or billing portal configuration. Never put live Stripe credentials in source control.

## Encrypted backup and isolated restore test

Backups use SQLite's online backup API, encrypt the standalone snapshot with GPG AES-256, and never archive the source tree or plaintext database. Configure `BACKUP_ROOT` to a mounted directory on independently managed storage; the script rejects a backup directory colocated with the live database. Independent storage is an operator prerequisite and is not provisioned by the Azure template.

```bash
export ASI_DB_PATH="$PWD/.data/asi-database.sqlite"
export BACKUP_ROOT='/mnt/independent-backup-storage'
read -r -s -p 'Backup encryption passphrase: ' BACKUP_PASSPHRASE
printf '\n'
export BACKUP_PASSPHRASE
bash scripts/azure/backup.sh
```

The output is a timestamped `.sqlite.gpg` file. Store the passphrase separately from the backup and verify that the configured mount is independent of the application compute before relying on it.

The restore drill decrypts and integrity-checks the database, then writes it only into a new directory. It refuses to overwrite an existing destination; it does not replace the live database:

```bash
export BACKUP_PATH='/mnt/independent-backup-storage/asi-db-<timestamp>.sqlite.gpg'
export RESTORE_DIR="/tmp/asi-db-restore-$(date -u +%Y%m%dT%H%M%SZ)"
bash scripts/azure/restore-test.sh
```

The recovery test in `test/backup.test.js` exercises encryption, schema/integrity verification, restored data, and overwrite protection locally. It does not verify Azure Storage, a remote backup mount, or restoration into a production service.

## Azure package and deployment

`./deploy-azure.sh deploy` always runs the API test suite and creates `.artifacts/asi-db-api.zip`. The package contains the app, migrations, static UI, operational backup helpers, and production dependencies; it excludes the worktree, `.env` files, and local `.data` database.

To perform a live deployment, first create an Azure resource group and authenticate with Azure CLI. Use a secure environment or secret manager for the administrator credentials, then explicitly opt in:

```bash
export AZURE_RESOURCE_GROUP='your-existing-resource-group'
export AZURE_REGION='eastus'
export APP_NAME='your-unique-asi-name'
export AZURE_WEBAPP_NAME='your-globally-unique-webapp-name'
export ADMIN_USERNAME='platform-admin'
read -r -s -p 'Initial administrator password: ' ADMIN_PASSWORD
printf '\n'
export ADMIN_PASSWORD
export AZURE_DEPLOYMENT_APPROVED=1
./deploy-azure.sh deploy
```

The deployment script requires Node.js 24, runs tests, builds a production-only artifact, deploys a Linux App Service plan and HTTPS-only Node 24 LTS web app, configures the app settings and initial administrator, publishes the zip, and retries `/health` plus `/api/v1/ready` over HTTPS. The Bicep template uses a B1 plan, system-assigned identity, TLS 1.2+, and `/home/data/asi-database.sqlite`. The database path relies on App Service persistent `/home` storage and is suitable only for one app instance.

The deployment command may create billable resources and mutate the selected resource group. It was not run as part of this change. The template does not create a Key Vault, managed-identity role assignments, an external backup store, or production networking. The administrator password is passed to Azure CLI via a mode-restricted temporary settings file and becomes a Web App setting; configure Key Vault references separately before treating that as an acceptable production secret-management design.

Use `./deploy-azure.sh plan` for a non-mutating summary and `./deploy-azure.sh health` for a remote HTTPS health/readiness check by setting `APP_URL`. No Azure provisioning or cloud charges occur unless the deploy command is explicitly invoked with `AZURE_DEPLOYMENT_APPROVED=1`.

## Recovery and rollback limits

Encrypted backup creation and isolated restore are implemented as described above. To roll back application code, redeploy a previously retained, known-good zip artifact with `az webapp deploy`; the repository does not automatically retain release artifacts or revert schema/data migrations. Do not restore a database over the live database using the isolated restore-test command. A production restore requires a separately reviewed maintenance procedure and an authorized outage.

## Verification policy

Local automated tests cover API authorization and validation, session expiry, SQLite persistence across app restarts, and encrypted backup/isolated restore. These are local integration tests, not live Azure or managed-database tests. Azure template compilation and local artifact startup do not establish that the app has been deployed, that HTTPS works in Azure, or that a remote backup has been restored.

Do not describe the system as production-ready until Azure deployment and HTTPS/readiness checks, independent backup storage, a restore drill, operational secret management, tenant user provisioning, commercial controls, and required production security/reliability testing have all been independently verified.
