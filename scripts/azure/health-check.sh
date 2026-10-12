#!/usr/bin/env bash
set -euo pipefail

APP_URL="${APP_URL:-http://localhost:3000}"

if ! command -v curl >/dev/null 2>&1; then
  echo "NOT IMPLEMENTED: curl is required to verify the app health endpoint." >&2
  exit 2
fi

if ! curl --fail --silent --show-error "$APP_URL/health" >/dev/null; then
  echo "NOT IMPLEMENTED: health verification is not available for a live Azure deployment in this repository." >&2
  exit 2
fi

echo "Health check passed locally at $APP_URL. Azure deployment health remains unverified."
