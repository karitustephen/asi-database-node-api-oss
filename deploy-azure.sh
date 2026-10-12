#!/usr/bin/env bash
set -euo pipefail

command="${1:-help}"

case "$command" in
  prerequisites)
    bash "$(dirname "$0")/scripts/azure/prerequisites.sh"
    ;;
  validate)
    bash "$(dirname "$0")/scripts/azure/validate-config.sh"
    ;;
  plan)
    bash "$(dirname "$0")/scripts/azure/plan.sh"
    ;;
  deploy)
    bash "$(dirname "$0")/scripts/azure/deploy.sh"
    ;;
  health)
    bash "$(dirname "$0")/scripts/azure/health-check.sh"
    ;;
  backup)
    bash "$(dirname "$0")/scripts/azure/backup.sh"
    ;;
  restore)
    bash "$(dirname "$0")/scripts/azure/restore-test.sh"
    ;;
  upgrade)
    bash "$(dirname "$0")/scripts/azure/upgrade.sh"
    ;;
  rollback)
    bash "$(dirname "$0")/scripts/azure/rollback-app.sh"
    ;;
  destroy)
    bash "$(dirname "$0")/scripts/azure/destroy.sh"
    ;;
  help|--help|-h)
    echo "Usage: ./deploy-azure.sh <prerequisites|validate|plan|deploy|health|backup|restore|upgrade|rollback|destroy>"
    ;;
  *)
    echo "Unknown command: $command" >&2
    exit 1
    ;;
esac
