# asi-database-node-api-oss

Open-source AI database node API for the Arybit Super Intelligence ecosystem, delivering a production-oriented API foundation, tenant-aware workflows, and repeatable Azure deployment automation.

## Status

This repository now contains a working Node.js API foundation with a documented Azure deployment flow. The implementation is intentionally production-minded but intentionally lightweight enough to validate in a local environment without external infrastructure.

Verified implementation status:
- API runtime: implemented in Node.js + Express
- Health endpoints: implemented and tested
- Authentication flow: implemented with login and bearer-token validation
- Tenant/project/database management: implemented in-memory with validation
- Azure deployment scripts: created and wired through `deploy-azure.sh`
- OpenAPI document: created as `openapi.yaml`
- Web console: basic UI served from `ui/public`
- Automated tests: included under `test/app.test.js`

## Architecture

The application follows a layered structure:
- `src/app.js` contains middleware, validation, auth, and route handlers.
- `src/server.js` boots the HTTP server.
- `openapi.yaml` describes the public contract.
- `scripts/azure` contains repeatable Azure deployment and operational scripts.
- `ui/public` contains a lightweight admin console that calls the API over HTTP.

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

- Credentials are intentionally stored in-memory only for local validation.
- Bearer tokens are required for protected routes.
- Secrets are not hardcoded into the browser bundle or deployment scripts.
- Azure scripts require explicit environment variables and confirmation before destructive commands.

## Azure deployment

The deployment entry point is:

```bash
./deploy-azure.sh help
```

Available commands:
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

Example:

```bash
export AZURE_SUBSCRIPTION_ID="<subscription-id>"
export AZURE_RESOURCE_GROUP="rg-asi-demo"
export AZURE_REGION="eastus"
./deploy-azure.sh prerequisites
./deploy-azure.sh validate
./deploy-azure.sh plan
```

## Remaining blockers

The repository does not include a live Azure subscription, MySQL/MariaDB endpoints, or production secrets. This implementation therefore validates the architecture, API contracts, and deployment workflow locally rather than claiming a live production deployment.

## Future work

The next implementation steps for a full commercial rollout are:
1. Add database engine adapters and migrations.
2. Move state to an actual relational database and queue.
3. Add RBAC enforcement and tenant isolation policies.
4. Implement real Azure Key Vault, networking, and managed identity integration.
5. Add browser-level UI actions for login, tenant creation, and database management.
