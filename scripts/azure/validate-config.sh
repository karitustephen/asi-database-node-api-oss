#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP before validation}"
: "${AZURE_REGION:?Set AZURE_REGION before validation}"
: "${ADMIN_USERNAME:?Set ADMIN_USERNAME before deployment}"
: "${ADMIN_PASSWORD:?Set ADMIN_PASSWORD before deployment}"
: "${APP_NAME:=asi-db-api}"
: "${AZURE_WEBAPP_NAME:=${APP_NAME}-app}"

if (( ${#ADMIN_PASSWORD} < 16 )); then
  echo "ADMIN_PASSWORD must contain at least 16 characters." >&2
  exit 2
fi

if [[ ! "$APP_NAME" =~ ^[A-Za-z0-9-]{2,50}$ || ! "$AZURE_WEBAPP_NAME" =~ ^[A-Za-z0-9-]{2,60}$ ]]; then
  echo "APP_NAME or AZURE_WEBAPP_NAME is not a valid Azure resource name." >&2
  exit 2
fi

if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI is required for live validation." >&2
  exit 2
fi

if ! az account show >/dev/null 2>&1; then
  echo "Azure authentication is required before validation can proceed." >&2
  exit 2
fi

if ! az group show --name "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Resource group $AZURE_RESOURCE_GROUP must already exist; deployment will not create it." >&2
  exit 2
fi

echo "Configuration validated for resource group $AZURE_RESOURCE_GROUP in $AZURE_REGION. The password value was not displayed."
