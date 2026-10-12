#!/usr/bin/env bash
set -euo pipefail

if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI is required but not installed." >&2
  exit 1
fi

az account show >/dev/null

echo "Azure CLI is configured and authenticated."
