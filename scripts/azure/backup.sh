#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP before backup}"

az backup vault list --resource-group "$AZURE_RESOURCE_GROUP" >/dev/null || echo "No backup vault found; backups are not configured yet."

echo "Backup workflow initialized for $AZURE_RESOURCE_GROUP."
