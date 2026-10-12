#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP before deployment}"
: "${AZURE_REGION:?Set AZURE_REGION before deployment}"
: "${APP_NAME:=asi-db-api}"

if ! command -v az >/dev/null 2>&1; then
  echo "NOT IMPLEMENTED: Live Azure deployment is blocked because Azure CLI is not installed." >&2
  exit 2
fi

if ! az account show >/dev/null 2>&1; then
  echo "NOT IMPLEMENTED: Live Azure deployment is blocked because Azure authentication is not configured." >&2
  exit 2
fi

echo "NOT IMPLEMENTED: Azure deployment has not been validated for a live subscription; do not use this script for production changes."
exit 2
