# asi-database-node-api-oss

Open-source AI database node API for the Arybit Super Intelligence ecosystem. This repository is an implementation foundation for a secure, multi-tenant database platform and Azure deployment workflow, but it does not claim production readiness or live Azure deployment maturity.

## Capability status

The project now distinguishes between capabilities that are implemented and locally verified versus those that are still blocked, placeholder-based, or intentionally not production-accepted.

Implemented and locally verified:
- Node.js + Express API foundation
- Health, readiness, and OpenAPI endpoints
- Username/password authentication with hashed credentials and bearer-token auth
- Tenant-scoped project and database listing with access enforcement
- Admin-only tenant creation and tenant isolation checks
- In-memory API key issuance and session lifecycle handling
- Persistent local unit/integration tests covering core authentication and tenant isolation logic
- Azure deployment entry point and script structure with explicit guardrails

Implemented but intentionally not production-accepted:
- In-memory state store; no durable relational persistence or migration engine
- Basic browser UI without full end-to-end authentication or tenant workflows
- Azure deployment scripts that verify local prerequisites but deliberately refuse live Azure mutation when configuration is absent or not yet verified

Not implemented or blocked:
- Real MySQL/MariaDB provisioning, migrations, TLS, backups, and restore automation
- Real Azure resource deployment to a verified subscription
- DNS, certificates, HTTPS validation, key vault integration, managed identity, or production networking
- Usage metering, plan enforcement, billing automation, and commercial SaaS controls

## Local development

Prerequisites:
- Node.js 18 or newer
- npm

Install dependencies:

```bash
npm install
```

Start the API:

```bash
npm start
```

Run tests:

```bash
npm test
```

Example health check:

```bash
curl http://localhost:3000/health
```

Example login:

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
```

## API overview

Core endpoints:
- `GET /health`
- `GET /api/v1/health`
- `GET /api/v1/ready`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/keys`
- `GET /api/v1/tenants`
- `POST /api/v1/tenants`
- `GET /api/v1/projects`
- `POST /api/v1/projects`
- `GET /api/v1/databases`
- `POST /api/v1/databases`
- `GET /api/v1/metrics`
- `GET /api/v1/audit`

## Security notes

- Stored credentials use PBKDF2 hashing rather than plaintext values.
- Protected routes require a valid bearer token or API key.
- Tenant-aware filtering enforces a basic multi-tenant isolation check at the API layer.
- No production Azure secrets or credentials are committed to this repository.

## Azure deployment status

The repository includes Azure deployment scaffolding, but it is not a verified production deployment.

Entry point:

```bash
./deploy-azure.sh help
```

Supported commands:
- `prerequisites`
- `validate`
- `plan`
- `deploy`
- `health`
- `backup`
- `restore`
- `upgrade`
- `rollback`
- `destroy`

Important:
- The scripts are intentionally defensive and fail with explicit `NOT IMPLEMENTED` messages when the environment is not ready for live Azure mutation.
- The repository does not include a verified Azure subscription, active DNS, or live certificate lifecycle.

## Acceptance and verification policy

The project should not be described as production-ready until all of the following are true:
1. A durable database layer with migrations is in place and tested.
2. Cross-tenant access, privilege escalation, and SQL injection tests pass.
3. Backup and restore operations are verified with a recovery drill.
4. Azure deployment succeeds in a controlled subscription and verifies app health over HTTPS.
5. DNS, TLS, secrets, and RBAC are validated by operational tests.
6. Commercial features such as usage metering and billing are implemented and audited.

## Near-term implementation priorities

1. Replace the in-memory state store with a durable database and migration system.
2. Add stronger RBAC, project ownership, and tenant-isolation validations.
3. Implement actual provisioning and status checks for MySQL/MariaDB resources.
4. Replace placeholder Azure operation scripts with controlled, auditable implementations or explicit `NOT IMPLEMENTED` failure paths.
5. Complete end-to-end UI flows for login, resource creation, and failure handling.

## Current verification summary

This repo is locally verified for:
- API startup
- Authentication
- Tenant isolation logic
- Testable API behavior

This repo is not yet verified for:
- Azure deployment execution
- Production-grade database persistence
- Backup/restore operations
- HTTPS and DNS automation
- Production acceptance or commercial SaaS operations
