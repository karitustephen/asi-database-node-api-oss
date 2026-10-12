#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_RESOURCE_GROUP:=rg-asi-demo}"
: "${AZURE_REGION:=eastus}"
: "${APP_NAME:=asi-db-api}"

cat <<EOT
Azure deployment plan (dry run only):
- Resource group: ${AZURE_RESOURCE_GROUP}
- Region: ${AZURE_REGION}
- App name: ${APP_NAME}
- Runtime: Node.js 18 application container or App Service deployment when verified
- Database: not yet implemented; MySQL/MariaDB provisioning is blocked until the database design is qualified
- Security: Key Vault, managed identity, TLS, and private networking are required before production Azure deployment
- Action: no live Azure mutation is attempted by this script
EOT
