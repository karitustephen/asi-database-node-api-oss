#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${BACKUP_ROOT:?Set BACKUP_ROOT to independently mounted backup storage}"
: "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE to an encryption passphrase}"

DB_PATH="${ASI_DB_PATH:-$(pwd)/.data/asi-database.sqlite}"
DB_PATH="$(realpath -m "$DB_PATH")"
BACKUP_ROOT="$(realpath -m "$BACKUP_ROOT")"
TARGET_PATH="${TARGET_PATH:-$BACKUP_ROOT/asi-db-$(date -u +%Y%m%dT%H%M%SZ).sqlite.gpg}"
TARGET_PATH="$(realpath -m "$TARGET_PATH")"

if [[ ! -f "$DB_PATH" ]]; then
  echo "SQLite database not found at $DB_PATH." >&2
  exit 2
fi

mkdir -p "$BACKUP_ROOT"
DB_DIRECTORY="$(dirname "$DB_PATH")"
case "$BACKUP_ROOT/" in
  "$DB_DIRECTORY/"*)
    echo "BACKUP_ROOT must not be the database directory or a subdirectory of it." >&2
    exit 2
    ;;
esac
case "$(dirname "$TARGET_PATH")/" in
  "$DB_DIRECTORY/"*)
    echo "TARGET_PATH must not be stored with the live database." >&2
    exit 2
    ;;
esac

if [[ -e "$TARGET_PATH" ]]; then
  echo "Backup destination already exists: $TARGET_PATH" >&2
  exit 2
fi

if ! command -v gpg >/dev/null 2>&1; then
  echo "gpg is required to encrypt backups." >&2
  exit 2
fi

SCRATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/asi-db-backup.XXXXXX")"
PARTIAL_PATH="$(mktemp "$BACKUP_ROOT/.asi-db-backup.XXXXXX")"
cleanup() {
  rm -rf -- "$SCRATCH_DIR"
  rm -f -- "$PARTIAL_PATH"
}
trap cleanup EXIT

node "$(dirname "$0")/sqlite-backup.js" "$DB_PATH" "$SCRATCH_DIR/database.sqlite"
node "$(dirname "$0")/validate-sqlite.js" "$SCRATCH_DIR/database.sqlite"
gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 \
  --symmetric --cipher-algo AES256 --output "$PARTIAL_PATH" "$SCRATCH_DIR/database.sqlite" \
  3<<<"$BACKUP_PASSPHRASE"
mv -n -- "$PARTIAL_PATH" "$TARGET_PATH"
if [[ -e "$PARTIAL_PATH" ]]; then
  echo "Backup destination appeared during creation; refusing to overwrite it: $TARGET_PATH" >&2
  exit 2
fi

echo "Encrypted SQLite backup created at $TARGET_PATH"
