#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_RESOURCE_GROUP:?Set AZURE_RESOURCE_GROUP before destruction}"
: "${CONFIRM_DESTROY:=0}"

if [[ "$CONFIRM_DESTROY" != "1" ]]; then
  echo "Destructive Azure operations are disabled unless CONFIRM_DESTROY=1 is set explicitly." >&2
  exit 2
fi

echo "Destruction is intentionally disabled in this repository until a production-backed verification workflow is approved."
exit 2
