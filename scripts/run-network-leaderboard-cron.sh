#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
lock_file="${TMPDIR:-/tmp}/dominator-network-leaderboard.lock"

exec 9>"$lock_file"
if ! flock -n 9; then
  echo "Network leaderboard update is already running; exiting."
  exit 0
fi

cd "$repo_dir"

if [[ -z "${UMA_API_KEY:-}" ]]; then
  echo "UMA_API_KEY is not set." >&2
  exit 1
fi

git pull --ff-only
node scripts/update-network-leaderboard.mjs
git add -- data/network-leaderboard.json

if git diff --cached --quiet; then
  echo "Leaderboard data did not change."
  exit 0
fi

git -c user.name="Dominator Network cron" \
    -c user.email="cron@dominator.network" \
    commit -m "Update network leaderboard"

if ! git push; then
  echo "Push raced with another update; rebasing once and retrying." >&2
  git pull --rebase --autostash
  git push
fi
