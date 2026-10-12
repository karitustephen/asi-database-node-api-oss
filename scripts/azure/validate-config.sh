#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID before validation}"
: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP before validation}"
: "${AZURE_REGION:?Set AZURE_REGION before validation}"

az account set --subscription "$AZURE_SUBSCRIPTION_ID"
az group show --name "$AZURE_RESOURCE_GROUP" --query name -o tsv >/dev/null
az provider show --namespace Microsoft.Compute --query registrationState -o tsv | grep -q "Registered"

echo "Azure configuration validated for resource group $AZURE_RESOURCE_GROUP in $AZURE_REGION."
