---
name: review-branch
description: "Code review of the current local branch against main (or a given base) for OpenCQRS, without a PR. Same workflow as /review-pr (opencqrs-review). Trigger: /review-branch [<base>], 'review my branch'"
---

# /review-branch

Reviews the committed state of the current branch, e.g. before opening a PR. Same standard and same workflow as `/review-pr`; the skill never changes code.

## Usage

```
/review-branch [<base-branch>] [--no-runtime]
```

Default base: `main` on `upstream` (if present, otherwise `origin`). Pass e.g. `origin/main` explicitly to review against the fork.

## Procedure

At the start, create one task per step with `TaskCreate` (prefix `[review-branch]`).

1. **Prepare:** `.claude/scripts/review-prepare.sh branch [<base>]`. If the script prints `WARN=Uncommitted changes …` on stderr, point out to the user that only `HEAD` is reviewed. Show the overview as in `/review-pr`.
2. **Determine the goal:** one sentence from the commit messages `git log --format=%s <BASE_REF>..HEAD`; if unclear, briefly ask the user.
3. **Run the workflow:** exactly as in `/review-pr` step 3 (`author` = `AUTHOR`).
4. **Check the result** and **clean up:** as in `/review-pr` steps 4–5.
5. **Show the result:** as in `/review-pr` step 6. No PR comments; instead offer to discuss or fix individual findings — fixing only on explicit request and as a separate step outside this skill.

## Rules

As for `/review-pr`.
