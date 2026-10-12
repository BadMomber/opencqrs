#!/usr/bin/env bash
# Checks out a GitHub pull request into its own worktree next to the repo, for manual review.
#
#   scripts/pr-worktree.sh <pr>        create (or refresh) ../opencqrs-pr-<n> on branch pr-<n>
#   scripts/pr-worktree.sh --rm <pr>   remove that worktree and its local branch
#
# <pr> is anything `gh pr view` understands: 104, owner:branch, or the PR URL.
set -euo pipefail

usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

remove=false
if [[ "${1:-}" == "--rm" ]]; then remove=true; shift; fi
[[ $# -eq 1 ]] || usage

number=$(gh pr view "$1" --json number -q .number)
main_root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
path="$(dirname "$main_root")/$(basename "$main_root")-pr-$number"
branch="pr-$number"

if $remove; then
  git -C "$main_root" worktree remove "$path"
  git -C "$main_root" branch -D "$branch"
  exit 0
fi

if [[ -d "$path" ]]; then
  if [[ -n "$(git -C "$path" status --porcelain)" ]]; then
    echo "error: $path has local changes, not refreshing" >&2
    exit 1
  fi
  echo "Refreshing existing worktree $path"
else
  git -C "$main_root" worktree add --quiet --detach "$path"
fi

(cd "$path" && gh pr checkout "$number" --branch "$branch" --force)

echo
echo "PR #$number ready for review in:"
echo "  $path"
