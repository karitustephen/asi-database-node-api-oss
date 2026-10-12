#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24 LTS is required before package creation and deployment." >&2
  exit 2
fi

if ! node --version | grep -q '^v24\.'; then
  echo "Node.js 24 LTS is required; found $(node --version)." >&2
  exit 2
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required before package creation and deployment." >&2
  exit 2
fi

if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI is not installed; live deployment will be blocked until it is added." >&2
  exit 2
fi

if ! az account show >/dev/null 2>&1; then
  echo "Azure CLI is installed but not authenticated. Run 'az login' before live deployment." >&2
  exit 2
fi

echo "Local prerequisite checks passed for Node.js 24 and Azure CLI."
