---
name: review-pr
description: "Code review of a GitHub PR for OpenCQRS: checks out the PR head into a worktree, runs the opencqrs-review workflow (3 reviewers, verifiers, runtime proof, consolidation) and offers to post findings as PR comments. Trigger: /review-pr <number|url>, 'review the PR'"
---

# /review-pr

Full code review of a pull request. The skill only reports — it never changes code, never commits and never posts anything without approval.

Orchestration: workflow `opencqrs-review` (`.claude/workflows/opencqrs-review.js`), shared with `/review-branch`. Domain foundation for the agents: `.claude/review/opencqrs-context.md`.

## Usage

```
/review-pr [<PR number or URL>] [--no-runtime]
```

Without a number: the PR of the current branch (`gh pr view --json number`). `--no-runtime` disables the Prove phase (no Gradle runs).

## Prerequisites

- `gh` logged in, `jq` installed
- For the Prove phase: a working Gradle build (Docker for Testcontainers tests)
- Invoking the skill is the opt-in for the workflow: usually 8 agents (3 reviewers, 3 verifiers, 1 prove, 1 consolidation)

## Procedure

At the start, create one task per step with `TaskCreate` (prefix `[review-pr]`).

### 1. Prepare

```bash
.claude/scripts/review-prepare.sh pr <nr|url>
```

The script finds the remote of the PR's base repository itself (for forks e.g. `upstream`), creates the worktree under `.review/pr-<nr>/src` and generates the diff artifacts. Remember the `KEY=VALUE` output.

Show the user: `LABEL`, author, `COMMITS`, `FILES`, `SHORTSTAT`, `BEHIND_BASE`.

### 2. Determine the goal of the change

One sentence on what the PR is meant to achieve — from the PR description (`gh pr view <nr> --json body`) and the commit messages. Only the goal, no assessment and no guesses about weaknesses (the reviewers should be unbiased).

### 3. Run the workflow

```
Workflow(name: "opencqrs-review", args: {
  repo: REPO, diffFiles: DIFF_FILES, diffByFileDir: DIFF_BY_FILE_DIR, fullDiff: FULL_DIFF,
  reportsDir: REPORTS_DIR, reviewFile: REVIEW_FILE, headSha: HEAD_SHA, baseRef: BASE_REF,
  label: LABEL, title: TITLE, author: AUTHOR, commits: COMMITS, files: FILES, shortstat: SHORTSTAT,
  behindBase: BEHIND_BASE, date: <today, YYYY-MM-DD>, goal: <sentence from step 2>,
  runtimeProof: <false with --no-runtime, otherwise true>
})
```

Pass args as a JSON object, not as a string. While the workflow runs, do not rebuild anything in parallel.

**On abort or failure:** do not restart; use `Workflow(scriptPath: <path from the tool result>, resumeFromRunId: <runId>)` with identical args.

### 4. Check the result

After the notification: are `failedTypes` and `unverifiedTypes` empty? Does `REVIEW_FILE` exist and is it non-empty (`ls -la`, do not read the whole file)? Report failures to the user and offer a resume before cleaning up.

### 5. Clean up

```bash
.claude/scripts/review-cleanup.sh <SLUG>
```

Removes the worktree and the ref. Reports stay under `.review/<SLUG>/` (gitignored).

### 6. Show the result

In the chat only: verdict, summary table from `rows`, counters (findings / refuted / proven at runtime), path of the review file. No full texts.

### 7. PR comments (optional)

`AskUserQuestion`:
- **"Yes — I'll pick findings"** — the user then names the numbers; only then post
- **"No — the file is enough"** — the skill ends

Post after the selection, as one coherent review:

```bash
gh api repos/<owner>/<repo>/pulls/<nr>/reviews -X POST --input <json>
```

with `commit_id` = `HEAD_SHA`, `event: "COMMENT"`, `body` = summary table (selected findings only) and `comments[]` with `path`, `line`, `side: "RIGHT"` and `body` per finding that has a diff position. Findings without a diff position go into `body` only. Show the JSON to the user before posting.

## Rules

- Never change code in the main repository, never commit or push. Temporary tests of the Prove phase exist only in the review worktree.
- Never publish anything on GitHub without the user's explicit selection.
- Orchestration lives in the workflow — do not start reviewers via the Agent tool alongside it.
- Only note how far the branch is behind the base; do not rebase.
- Always clean up the worktree, also after failures — but ask first if a resume may be needed.
