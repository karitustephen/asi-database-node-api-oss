#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP before restore test}"

echo "Restore validation is ready for resource group $AZURE_RESOURCE_GROUP."
