#!/usr/bin/env bash
set -euo pipefail

if ! command -v az >/dev/null 2>&1; then
  echo "NOT IMPLEMENTED: Azure CLI is required for live Azure validation, but it is not installed in this environment." >&2
  exit 2
fi

if ! az account show >/dev/null 2>&1; then
  echo "NOT IMPLEMENTED: Azure CLI is installed but not authenticated. Run 'az login' before attempting Azure deployment." >&2
  exit 2
fi

echo "Local Azure prerequisite checks passed; live deployment remains unverified in this repository."
