#!/usr/bin/env bash
set -euo pipefail

: "${APP_NAME:=asi-db-api}"

echo "Rolling back application deployment for $APP_NAME."
