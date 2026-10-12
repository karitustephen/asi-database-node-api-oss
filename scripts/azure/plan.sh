#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_RESOURCE_GROUP:=rg-asi-demo}"
: "${AZURE_REGION:=eastus}"
: "${APP_NAME:=asi-db-api}"

cat <<EOT
Planned deployment:
- Resource group: $AZURE_RESOURCE_GROUP
- Region: $AZURE_REGION
- App: $APP_NAME
- Base image: Ubuntu 22.04 LTS
- Database Type: MySQL/MariaDB on Azure VM or managed service when approved
- Security: Key Vault, private networking, RBAC, TLS, and least-privilege identities
EOT
