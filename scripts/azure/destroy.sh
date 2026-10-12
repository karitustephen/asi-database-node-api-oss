#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP before destruction}"
: "${CONFIRM_DESTROY:=0}"

if [[ "$CONFIRM_DESTROY" != "1" ]]; then
  echo "Refusing to destroy Azure resources without CONFIRM_DESTROY=1." >&2
  exit 2
fi

echo "Destroying Azure resource group $AZURE_RESOURCE_GROUP."
az group delete --name "$AZURE_RESOURCE_GROUP" --yes --no-wait
