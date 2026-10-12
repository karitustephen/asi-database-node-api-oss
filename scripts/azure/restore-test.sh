#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${BACKUP_PATH:?Set BACKUP_PATH to an encrypted SQLite backup}"
: "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE to the backup encryption passphrase}"

if [[ ! -f "$BACKUP_PATH" ]]; then
  echo "Encrypted backup not found: $BACKUP_PATH" >&2
  exit 2
fi
if ! command -v gpg >/dev/null 2>&1; then
  echo "gpg is required to decrypt backups." >&2
  exit 2
fi

RESTORE_PARENT="${RESTORE_PARENT:-${TMPDIR:-/tmp}}"
RESTORE_DIR="${RESTORE_DIR:-$RESTORE_PARENT/asi-db-restore-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
RESTORE_DIR="$(realpath -m "$RESTORE_DIR")"
if [[ -e "$RESTORE_DIR" ]]; then
  echo "Restore destination already exists; refusing to overwrite it: $RESTORE_DIR" >&2
  exit 2
fi

SCRATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/asi-db-restore.XXXXXX")"
cleanup() {
  rm -rf -- "$SCRATCH_DIR"
}
trap cleanup EXIT

gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 \
  --decrypt --output "$SCRATCH_DIR/database.sqlite" "$BACKUP_PATH" \
  3<<<"$BACKUP_PASSPHRASE"
node "$(dirname "$0")/validate-sqlite.js" "$SCRATCH_DIR/database.sqlite"

mkdir -p "$(dirname "$RESTORE_DIR")"
mkdir -- "$RESTORE_DIR"
mv -- "$SCRATCH_DIR/database.sqlite" "$RESTORE_DIR/asi-database.sqlite"

echo "Backup integrity and schema checks passed; isolated restore is at $RESTORE_DIR"
