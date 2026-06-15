#!/bin/sh
set -e

# Navigate to repo root
cd "$(dirname "$0")"

branch=$(git branch --show-current 2>/dev/null || git rev-parse --short HEAD)

# Stage all tracked changes and new files (ignored files like .env will not be added)
git add -A

# If no changes were staged, exit cleanly
if git diff --cached --quiet && git diff --quiet; then
  echo "No changes to commit."
  exit 0
fi

message=${1:-"Auto commit: save local changes and push"}
git commit -m "$message"
git push origin "$branch"

echo "✅ Pushed to origin/$branch"
