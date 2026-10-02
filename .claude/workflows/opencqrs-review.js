export const meta = {
  name: 'opencqrs-review',
  description: 'OpenCQRS code review: 3 specialised reviewers, one adversarial verifier per report, runtime proof for open core claims, consolidated report',
  whenToUse: 'Invoked by /review-pr and /review-branch after .claude/scripts/review-prepare.sh has run. Not meant to be started by hand.',
  phases: [
    { title: 'Review', detail: 'review-correctness, review-design, review-tests-docs in parallel' },
    { title: 'Verify', detail: 'one review-verifier per report as soon as it exists (static, tries to refute)' },
    { title: 'Prove', detail: 'one review-verifier in runtime mode for unclear findings and Errors that need execution' },
    { title: 'Consolidate', detail: 'dedupe across reviewers and write the review file' },
  ],
}

// Input contract (values from review-prepare.sh, passed through by the calling skill):
//   repo, diffFiles, diffByFileDir, fullDiff, reportsDir, reviewFile, headSha, baseRef, title, label, date
//   behindBase, commits, files, shortstat, author (optional, header only)
//   goal (one sentence: what the change is meant to do, from PR body / commits)
//   runtimeProof (boolean, default true): allow the Prove phase to run Gradle in the review worktree
const a = args
const required = ['repo', 'diffFiles', 'diffByFileDir', 'fullDiff', 'reportsDir', 'reviewFile', 'headSha', 'baseRef', 'label', 'date', 'goal']
const missing = required.filter(k => a?.[k] === undefined || a[k] === null || a[k] === '')
if (missing.length) throw new Error(`opencqrs-review: missing args ${missing.join(', ')}`)
const runtimeProof = a.runtimeProof !== false

const TYPES = [
  { key: 'correctness', name: 'Correctness' },
  { key: 'design', name: 'Design' },
  { key: 'tests-docs', name: 'Tests & Docs' },
]

const SEVERITY = { type: 'string', enum: ['Error', 'Warning', 'Suggestion'] }

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['outputPath', 'findings'],
  properties: {
    outputPath: { type: 'string', description: 'Path of the report written with Write' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'severity', 'location', 'title', 'claim', 'needsRuntimeProof'],
        properties: {
          id: { type: 'string', description: 'C1, D2, T3 ... as in the report' },
          severity: SEVERITY,
          location: { type: 'string', description: 'path:line relative to repo root' },
          title: { type: 'string' },
          claim: { type: 'string', description: 'One or two sentences: what is wrong and the failure scenario' },
          needsRuntimeProof: { type: 'boolean' },
          proofIdea: { type: 'string', description: 'Gradle task or test idea, when needsRuntimeProof' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'verdict', 'evidence'],
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unclear'] },
          adjustedSeverity: SEVERITY,
          evidence: { type: 'string', description: 'Code citation, counter-evidence or command output that decides the verdict' },
        },
      },
    },
  },
}

const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['reviewFile', 'verdict', 'rows'],
  properties: {
    reviewFile: { type: 'string' },
    verdict: { type: 'string', enum: ['ready to merge', 'changes requested', 'blocked'] },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        required: ['number', 'severity', 'location', 'title', 'sources', 'status'],
        properties: {
          number: { type: 'integer' },
          severity: SEVERITY,
          location: { type: 'string' },
          title: { type: 'string' },
          sources: { type: 'string', description: 'Original finding ids, e.g. "C1, T4"' },
          status: { type: 'string', enum: ['confirmed', 'confirmed (runtime)', 'unclear'] },
        },
      },
    },
  },
}

const inputs = `REPO=${a.repo}
DIFF_FILES=${a.diffFiles}
DIFF_BY_FILE_DIR=${a.diffByFileDir}
FULL_DIFF=${a.fullDiff}`

const reviewerPrompt = type => `${inputs}
OUTPUT=${a.reportsDir}/${type.key}.md
CONTEXT=${a.label}. Goal of the change: ${a.goal}

Review the whole diff from your perspective. Write the complete report with Write to OUTPUT.
Return the structured result: the report path and every finding of the report (same ids). Never return the report text.`

const verifierPrompt = (type, report, mode, findings) => `${inputs}
REPORT=${report}
MODE=${mode}
FINDINGS=${JSON.stringify(findings)}

Reviewer type: ${type}. Verify every finding in FINDINGS independently and try to refute it.
Return one verdict per finding id.`

// Review → Verify per type, no barrier: a report is verified as soon as it exists.
const results = await pipeline(
  TYPES,
  type => agent(reviewerPrompt(type), {
    agentType: `review-${type.key}`,
    phase: 'Review',
    label: `review:${type.key}`,
    schema: FINDINGS_SCHEMA,
  }),
  (report, type) => {
    if (!report) return null
    if (!report.findings.length) return { type, report, verdicts: [] }
    return agent(verifierPrompt(type.name, report.outputPath, 'static', report.findings), {
      agentType: 'review-verifier',
      phase: 'Verify',
      label: `verify:${type.key}`,
      schema: VERDICT_SCHEMA,
    }).then(v => ({ type, report, verdicts: v?.verdicts ?? null }))
  },
)

const done = results.filter(Boolean)
const failedTypes = TYPES.filter(t => !done.some(d => d.type.key === t.key)).map(t => t.key)
if (failedTypes.length) log(`no report for: ${failedTypes.join(', ')} -- the review file will mark these sections as failed`)
const unverifiedTypes = done.filter(d => d.verdicts === null).map(d => d.type.key)
if (unverifiedTypes.length) log(`verifier failed for: ${unverifiedTypes.join(', ')} -- their findings stay "unclear"`)

// Merge each finding with its verdict. Missing verdict = unclear.
const merged = done.flatMap(d => d.report.findings.map(f => {
  const v = (d.verdicts ?? []).find(x => x.id === f.id)
  return { ...f, type: d.type.key, report: d.report.outputPath, verdict: v?.verdict ?? 'unclear', adjustedSeverity: v?.adjustedSeverity, evidence: v?.evidence ?? '' }
}))
const refuted = merged.filter(f => f.verdict === 'refuted')
log(`${merged.length} findings, ${refuted.length} refuted statically`)

// Prove: one agent, sequential Gradle runs in the single review worktree (parallel builds would fight over it).
const toProve = merged.filter(f =>
  f.verdict === 'unclear' ||
  (f.verdict === 'confirmed' && f.needsRuntimeProof && (f.adjustedSeverity ?? f.severity) === 'Error'))
let proofs = []
if (!runtimeProof) {
  if (toProve.length) log(`runtime proof disabled -- ${toProve.length} findings keep their static verdict`)
} else if (toProve.length) {
  phase('Prove')
  const r = await agent(verifierPrompt('mixed', `${a.reportsDir}/proof.md`, 'runtime', toProve.map(({ id, severity, location, title, claim, proofIdea, evidence }) => ({ id, severity, location, title, claim, proofIdea, staticEvidence: evidence }))), {
    agentType: 'review-verifier',
    phase: 'Prove',
    label: 'prove',
    schema: VERDICT_SCHEMA,
  })
  if (!r) log('prove agent failed -- findings keep their static verdict')
  proofs = r?.verdicts ?? []
}
const final = merged.map(f => {
  const p = proofs.find(x => x.id === f.id)
  return p ? { ...f, verdict: p.verdict, adjustedSeverity: p.adjustedSeverity ?? f.adjustedSeverity, evidence: `${f.evidence}\nRuntime: ${p.evidence}`, proven: true } : f
})

phase('Consolidate')
const sections = TYPES.map(t => {
  const d = done.find(x => x.type.key === t.key)
  return `- ${t.name}: ${d ? d.report.outputPath : 'MISSING (reviewer failed)'}`
}).join('\n')

const summary = await agent(`Consolidate an OpenCQRS code review into ${a.reviewFile}. Report only, never change code.

Reviewer reports (read them yourself with Read for the full detail of each finding):
${sections}

Verified findings as JSON (verdict per finding; "refuted" ones are rejected, "unclear" ones stay but are marked):
${JSON.stringify(final.map(({ id, type, severity, adjustedSeverity, location, title, claim, verdict, evidence, proven }) => ({ id, type, severity: adjustedSeverity ?? severity, location, title, claim, verdict, evidence, proven: Boolean(proven) })))}

Write the file with this structure (English prose):

# Code review: ${a.label}

${a.author ? `**Author:** ${a.author} · ` : ''}**Head:** \`${a.headSha}\` · **Base:** \`${a.baseRef}\` · **Date:** ${a.date}
**Scope:** ${a.commits ?? '?'} commits · ${a.files ?? '?'} files${a.shortstat ? ` · ${a.shortstat}` : ''}
**Reviewer:** Claude Code (opencqrs-review: correctness, design, tests & docs; one verifier per report${runtimeProof ? ', runtime proof' : ''})
${Number(a.behindBase) > 0 ? `\n> **Note:** The reviewed state was ${a.behindBase} commit(s) behind the base (not rebased).\n` : ''}${failedTypes.length ? `\n> **Incomplete:** no report for ${failedTypes.join(', ')}.\n` : ''}
**Verdict:** ready to merge | changes requested | blocked  (blocked as soon as a confirmed Error exists)

## Summary
| # | Severity | Location | Title | Source | Status |
One row per consolidated finding, numbered, sorted Error -> Warning -> Suggestion.

## Findings
One "### <#> [Severity] <Title>" section per row: Location, Evidence, Scenario, Recommendation (with code sketches from the reports),
Verification (verdict evidence, runtime output if proven), Source.

## Refuted
Every refuted finding with id, title and the counter-evidence in one or two lines.

## Checked without findings
Merged from the reports' "Checked without findings" sections.

Rules:
- Dedupe: findings from different reviewers about the same location and the same cause become one row; list all ids in Source and take the highest severity among the confirmed ones.
- Status: "confirmed (runtime)" when proven=true and confirmed, "confirmed" when confirmed, "unclear" when unclear.
- Do not invent findings and do not drop unclear ones.

Return the structured summary: file path, verdict and the table rows exactly as written.`, {
  phase: 'Consolidate',
  label: 'consolidate',
  schema: SUMMARY_SCHEMA,
})

return {
  reviewFile: a.reviewFile,
  verdict: summary?.verdict ?? null,
  rows: summary?.rows ?? [],
  counts: {
    findings: merged.length,
    refuted: refuted.length,
    proven: proofs.length,
  },
  failedTypes,
  unverifiedTypes,
}
