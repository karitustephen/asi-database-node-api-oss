#!/usr/bin/env bash
set -euo pipefail

APP_URL="${APP_URL:-http://localhost:3000}"

curl --fail --silent --show-error "$APP_URL/health" >/dev/null

echo "Health check passed for $APP_URL."
