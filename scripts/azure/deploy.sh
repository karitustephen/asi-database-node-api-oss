#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP before deployment}"
: "${AZURE_REGION:?Set AZURE_REGION before deployment}"
: "${APP_NAME:=asi-db-api}"

az group create --name "$AZURE_RESOURCE_GROUP" --location "$AZURE_REGION" >/dev/null
az deployment group create \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --template-file "$(dirname "$0")/templates/main.bicep" \
  --parameters appName="$APP_NAME" location="$AZURE_REGION" >/dev/null

echo "Deployment complete for $APP_NAME."
