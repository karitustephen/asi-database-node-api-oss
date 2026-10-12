#!/usr/bin/env bash
set -euo pipefail

if ! command -v az >/dev/null 2>&1; then
  echo "NOT IMPLEMENTED: Azure validation cannot run because the Azure CLI is unavailable." >&2
  exit 2
fi

: "${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID to validate the target subscription}"
: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP to validate the target resource group}"
: "${AZURE_REGION:?Set AZURE_REGION to validate the target region}"

if ! az account show >/dev/null 2>&1; then
  echo "NOT IMPLEMENTED: Azure authentication is required before a deployment can be validated." >&2
  exit 2
fi

echo "NOT IMPLEMENTED: Azure resource validation is intentionally blocked until a tested subscription and deployment plan are available."
exit 2
