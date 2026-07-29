#!/usr/bin/env zsh
# setup-env.zsh — set AWS creds
# Run once after cloning: source setup-env.zsh
PROJECT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
ENV_FILE="$PROJECT_DIR/.env.dev"
if [[ -f "$ENV_FILE" ]]; then
  echo "==> Loading AWS credentials from .env.dev ..."
  set -o allexport
  source "$ENV_FILE"
  set +o allexport
  echo "    AWS credentials loaded (region: $AWS_DEFAULT_REGION)"
else
  echo "==> Skipping AWS credentials (.env.dev not found)"
  echo "    Copy .env.example to .env.dev and fill in your credentials to enable AWS targets."
fi

echo ""
echo "✓ Environment ready. Your shell is now using venv/"
echo "  To activate later in a new shell:"
echo "    source setup-env.zsh"
echo ""
echo "  Next step — run a dry-run to enumerate your XLSX sheets:"
echo "    python -m ingestion.ingest --dry-run"
