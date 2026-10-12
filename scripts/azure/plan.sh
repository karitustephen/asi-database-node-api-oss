#!/usr/bin/env bash
set -euo pipefail

AZURE_RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-<existing-resource-group>}"
AZURE_REGION="${AZURE_REGION:-eastus}"
APP_NAME="${APP_NAME:-asi-db-api}"
AZURE_WEBAPP_NAME="${AZURE_WEBAPP_NAME:-${APP_NAME}-app}"

cat <<EOT
Azure deployment plan (dry run):
- Resource group: ${AZURE_RESOURCE_GROUP}
- Region: ${AZURE_REGION}
- App name: ${APP_NAME}
- Runtime: Node.js 24 LTS on HTTPS-only App Service
- Persistent SQLite path: /home/data/asi-database.sqlite (single instance only)
- Build: run tests, install production dependencies, create a minimal zip package
- Runtime configuration: NODE_ENV=production, PORT=8080, explicit initial admin secret
- Security: system-assigned managed identity, HTTPS-only, TLS 1.2+
- Operational checks: retrying remote health check and encrypted SQLite restore drill
- Live changes: require AZURE_DEPLOYMENT_APPROVED=1; this plan does not deploy anything
EOT
