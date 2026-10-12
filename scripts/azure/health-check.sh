#!/usr/bin/env bash
set -euo pipefail

APP_URL="${APP_URL:-http://localhost:3000}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to verify application health." >&2
  exit 2
fi

case "$APP_URL" in
  http://localhost*|http://127.0.0.1*) ;;
  https://*) ;;
  *)
    echo "Remote health checks must use HTTPS." >&2
    exit 2
    ;;
esac

check_endpoint() {
  local endpoint="$1"
  local response
  response="$(curl --fail --silent --show-error --retry 10 --retry-delay 5 --retry-connrefused --max-time 15 "$APP_URL$endpoint")"
  printf '%s' "$response" | node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      try {
        const payload = JSON.parse(body);
        if (!["ok", "ready"].includes(payload.status)) process.exitCode = 1;
      } catch {
        process.exitCode = 1;
      }
    });
  '
}

check_endpoint /health
check_endpoint /api/v1/ready

echo "Health and readiness checks passed for $APP_URL."
