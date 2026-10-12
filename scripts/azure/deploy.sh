#!/usr/bin/env bash
set -euo pipefail
umask 077

APP_NAME="${APP_NAME:-asi-db-api}"
AZURE_RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-}"
AZURE_REGION="${AZURE_REGION:-eastus}"
AZURE_WEBAPP_NAME="${AZURE_WEBAPP_NAME:-${APP_NAME}-app}"
ARTIFACT_DIR="${ARTIFACT_DIR:-.artifacts}"
APPROVED="${AZURE_DEPLOYMENT_APPROVED:-0}"

if [[ ! "$APP_NAME" =~ ^[A-Za-z0-9-]{2,50}$ ]]; then
  echo "APP_NAME must contain 2-50 letters, numbers, or hyphens." >&2
  exit 2
fi
if [[ ! "$AZURE_WEBAPP_NAME" =~ ^[A-Za-z0-9-]{2,60}$ ]]; then
  echo "AZURE_WEBAPP_NAME must contain 2-60 letters, numbers, or hyphens." >&2
  exit 2
fi
if [[ -n "${ASI_PLAN_QUOTAS:-}" ]]; then
  node - "$ASI_PLAN_QUOTAS" <<'NODE'
const { createPlanConfiguration } = require('./src/plans');
try {
  createPlanConfiguration(JSON.parse(process.argv[2]));
} catch (error) {
  console.error(`Invalid ASI_PLAN_QUOTAS: ${error.message}`);
  process.exit(2);
}
NODE
fi

if [[ -n "${STRIPE_SECRET_KEY:-}${STRIPE_WEBHOOK_SECRET:-}${STRIPE_PRICE_STARTER:-}${STRIPE_PRICE_PRO:-}${STRIPE_PRICE_GROWTH:-}" ]]; then
  if [[ -z "${STRIPE_SECRET_KEY:-}" || -z "${STRIPE_WEBHOOK_SECRET:-}" || -z "${STRIPE_PRICE_STARTER:-}" || -z "${STRIPE_PRICE_PRO:-}" || -z "${STRIPE_PRICE_GROWTH:-}" ]]; then
    echo "STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and all three STRIPE_PRICE_* values are required when configuring Stripe billing." >&2
    exit 2
  fi
fi
if [[ -n "${PUBLIC_APP_URL:-}" && ! "$PUBLIC_APP_URL" =~ ^https:// ]]; then
  echo "PUBLIC_APP_URL must use HTTPS for Stripe billing." >&2
  exit 2
fi
if [[ -n "${ASI_TENANT_PG_URL:-}" ]]; then
  node - "$ASI_TENANT_PG_URL" "${ASI_TENANT_PG_SSL:-}" \
    "${ASI_TENANT_PG_POOL_MAX:-}" "${ASI_TENANT_PG_CONNECT_TIMEOUT_MS:-}" \
    "${ASI_TENANT_PG_IDLE_TIMEOUT_MS:-}" "${ASI_TENANT_PG_STATEMENT_TIMEOUT_MS:-}" <<'NODE'
try {
  const url = new URL(process.argv[2]);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
  const ssl = process.argv[3].toLowerCase();
  if (ssl && !['true', 'false'].includes(ssl)) throw new Error();
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (ssl === 'false' && !['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    throw new Error();
  }
  const ranges = [[4, 1, 20], [5, 100, 30000], [6, 1000, 300000], [7, 100, 30000]];
  for (const [index, minimum, maximum] of ranges) {
    if (process.argv[index] === '') continue;
    const value = Number(process.argv[index]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error();
  }
} catch {
  console.error('Tenant PostgreSQL URL, TLS, or pool settings are invalid; remote PostgreSQL requires TLS.');
  process.exit(2);
}
NODE
fi

for tool in node npm zip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required to build the deployment artifact." >&2
    exit 2
  fi
done
if ! node --version | grep -q '^v24\.'; then
  echo "Node.js 24 LTS is required to build the deployment artifact; found $(node --version)." >&2
  exit 2
fi

npm test

STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/asi-db-package.XXXXXX")"
PACKAGE_DIR="$(realpath -m "$ARTIFACT_DIR")"
mkdir -p "$PACKAGE_DIR"
PACKAGE_PATH="$PACKAGE_DIR/${APP_NAME}.zip"
PARTIAL_PACKAGE="$(mktemp "$PACKAGE_DIR/.${APP_NAME}.zip.XXXXXX")"
rm -f -- "$PARTIAL_PACKAGE"
APP_SETTINGS_FILE=""
cleanup() {
  rm -rf -- "$STAGING_DIR"
  rm -f -- "$PARTIAL_PACKAGE"
  if [[ -n "$APP_SETTINGS_FILE" ]]; then
    rm -f -- "$APP_SETTINGS_FILE"
  fi
}
trap cleanup EXIT

cp package.json package-lock.json openapi.yaml "$STAGING_DIR/"
cp -R src ui "$STAGING_DIR/"
mkdir -p "$STAGING_DIR/scripts/azure"
cp scripts/azure/backup.sh scripts/azure/restore-test.sh \
  scripts/azure/sqlite-backup.js scripts/azure/validate-sqlite.js \
  "$STAGING_DIR/scripts/azure/"
npm ci --omit=dev --prefix "$STAGING_DIR"
(
  cd "$STAGING_DIR"
  zip -qr "$PARTIAL_PACKAGE" .
)
mv -f -- "$PARTIAL_PACKAGE" "$PACKAGE_PATH"
echo "Deployment artifact created: $PACKAGE_PATH"

if [[ "$APPROVED" != "1" ]]; then
  echo "Live Azure changes were not approved. Artifact packaging completed; no Azure resources were changed."
  exit 0
fi

: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP before live deployment}"
: "${ADMIN_USERNAME:?Set ADMIN_USERNAME for secure initial administrator provisioning}"
: "${ADMIN_PASSWORD:?Set ADMIN_PASSWORD (at least 16 characters) for secure initial administrator provisioning}"
if (( ${#ADMIN_PASSWORD} < 16 )); then
  echo "ADMIN_PASSWORD must contain at least 16 characters." >&2
  exit 2
fi
if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI is required for live deployment." >&2
  exit 2
fi
if ! az account show >/dev/null 2>&1; then
  echo "Azure authentication is required before live deployment is possible." >&2
  exit 2
fi
if ! az group show --name "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Resource group $AZURE_RESOURCE_GROUP must exist before deployment; it was not created." >&2
  exit 2
fi

APP_SETTINGS_FILE="$(mktemp "${TMPDIR:-/tmp}/asi-db-app-settings.XXXXXX.json")"
node - "$APP_SETTINGS_FILE" "$AZURE_WEBAPP_NAME" <<'NODE'
const fs = require('node:fs');
const outputPath = process.argv[2];
const webAppName = process.argv[3];
const settings = {
  ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  NODE_ENV: 'production',
  PORT: '8080',
  ASI_DB_PATH: '/home/data/asi-database.sqlite',
  WEBSITE_ENABLE_APP_SERVICE_STORAGE: 'true',
  WEBSITE_RUN_FROM_PACKAGE: '1',
  PUBLIC_APP_URL: process.env.PUBLIC_APP_URL || `https://${webAppName}.azurewebsites.net`,
};
for (const name of [
  'ASI_PLAN_QUOTAS',
  'ASI_USAGE_GRACE_PERIOD_SECONDS',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_STARTER',
  'STRIPE_PRICE_PRO',
  'STRIPE_PRICE_GROWTH',
  'ASI_TENANT_PG_URL',
  'ASI_TENANT_PG_SSL',
  'ASI_TENANT_PG_POOL_MAX',
  'ASI_TENANT_PG_CONNECT_TIMEOUT_MS',
  'ASI_TENANT_PG_IDLE_TIMEOUT_MS',
  'ASI_TENANT_PG_STATEMENT_TIMEOUT_MS',
]) {
  if (process.env[name]) settings[name] = process.env[name];
}
fs.writeFileSync(outputPath, JSON.stringify(settings), { mode: 0o600 });
NODE
chmod 600 "$APP_SETTINGS_FILE"

TEMPLATE_PATH="$(dirname "$0")/templates/main.bicep"
az deployment group create \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "${APP_NAME}-$(date -u +%Y%m%d%H%M%S)" \
  --template-file "$TEMPLATE_PATH" \
  --parameters appName="$APP_NAME" webAppName="$AZURE_WEBAPP_NAME" location="$AZURE_REGION" \
  --output none

az webapp config appsettings set \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_WEBAPP_NAME" \
  --settings "@$APP_SETTINGS_FILE" \
  --output none

az webapp deploy \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_WEBAPP_NAME" \
  --src-path "$PACKAGE_PATH" \
  --type zip \
  --output none

APP_URL="https://${AZURE_WEBAPP_NAME}.azurewebsites.net"
export APP_URL
bash "$(dirname "$0")/health-check.sh"

echo "Deployment and remote health verification succeeded for $APP_URL."
