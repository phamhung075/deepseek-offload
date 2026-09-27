/**
 * `jev conflicts` — flag findings from different jobs that contradict each other.
 *
 * Code does the cheap part first: it extracts findings (bullet/numbered lines,
 * and sentences that cite a path) from each job's result text, then pairs only
 * findings from different jobs that mention the same file path, capped at
 * PAIRS_MAX. Each surviving pair gets one `contradicts` noul — the wording the
 * known-answer evaluation measured, 2026-09-27 — and pairs at or above 0.5 are
 * reported with both finding texts shortened and both job ids.
 *
 * It SUGGESTS where to look; the orchestrator decides which findings are real.
 * The evaluation was SYNTHETIC, so that caveat prints every time.
 */
import fs from 'node:fs'
import path from 'node:path'
import { callJev, isEnabled, DISABLED_LINE, pool, CONCURRENCY, probability } from './client.mjs'
import { CONTRADICTS_ID, CONTRADICTS_QUESTION } from './questions.mjs'

/** At most this many pairs are ever sent, so one huge job pair cannot blow up state. */
export const PAIRS_MAX = 60

/** Characters of each finding sent to Jev (the measured eval shape). */
export const SIDE_CHARS = 800

/** Characters of each finding kept in the report. */
export const REPORT_SIDE_CHARS = 200

/** A pair at or above this probability is reported as a possible contradiction. */
export const CONTRADICTS_THRESHOLD = 0.5

/** The always-printed caveat. */
export const CONFLICTS_CAVEAT = 'measured on synthetic contradictions only (AUC 0.997)'

/**
 * Paths that look like repository files (with a known extension), optionally
 * carrying a `:line` / `:~line` citation. Line numbers are stripped, because the
 * prefilter compares files.
 */
export const PATH_RE =
  /(?:[A-Za-z0-9_@][A-Za-z0-9_@./-]*\.(?:go|rs|ts|tsx|js|jsx|mjs|cjs|py|sh|bash|yml|yaml|toml|json|sql|proto|md|mod|conf|cfg|ini|css|html|xml|txt))(?::~?\d+)?/g

/** The unique file paths a text cites. */
export function extractPaths(text) {
  const paths = []
  for (const match of String(text).matchAll(PATH_RE)) {
    const value = match[0].replace(/:~?\d+$/, '')
    if (!paths.includes(value)) paths.push(value)
  }
  return paths
}

const ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s+/

/**
 * Extract findings from one result text: bullet/numbered lines, then prose
 * sentences. A finding with no path is dropped, because it can never satisfy
 * the shared-path prefilter.
 * @returns `{text, paths}[]`.
 */
export function extractFindings(text) {
  const findings = []
  const add = (raw) => {
    const trimmed = String(raw).replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim()
    if (trimmed === '') return
    const paths = extractPaths(trimmed)
    if (paths.length === 0) return
    findings.push({ text: trimmed, paths })
  }
  for (const block of String(text).split(/\n\s*\n/)) {
    const lines = block.split('\n')
    const items = lines.filter((line) => ITEM_RE.test(line))
    if (items.length > 0) {
      for (const line of items) add(line)
      continue
    }
    for (const sentence of block.split(/(?<=[.!?])\s+/)) {
      add(sentence)
    }
  }
  return findings
}

/**
 * Pair findings across different jobs that share a file path, in a stable
 * order, capped at PAIRS_MAX.
 * @param jobFindings - `[{jobId, findings: [{text, paths}]}]`.
 * @returns `{jobA, jobB, path, a, b}[]`.
 */
export function planPairs(jobFindings) {
  const pairs = []
  for (let i = 0; i < jobFindings.length; i++) {
    for (let j = i + 1; j < jobFindings.length; j++) {
      const left = jobFindings[i]
      const right = jobFindings[j]
      if (left.jobId === right.jobId) continue
      for (const findingA of left.findings) {
        for (const findingB of right.findings) {
          const shared = findingA.paths.find((candidate) => findingB.paths.includes(candidate))
          if (shared === undefined) continue
          pairs.push({ jobA: left.jobId, jobB: right.jobId, path: shared, a: findingA.text, b: findingB.text })
          if (pairs.length >= PAIRS_MAX) return pairs
        }
      }
    }
  }
  return pairs
}

const trim = (text, chars) => (text.length > chars ? `${text.slice(0, chars)}…` : text)

/** Read one job's result text, preferring the stored result file. */
function resultTextFor(jobId, job, ctx) {
  const candidates = []
  if (typeof job.resultFile === 'string' && job.resultFile !== '' && typeof ctx.projectRoot === 'string') {
    candidates.push(path.resolve(ctx.projectRoot, job.resultFile))
  }
  candidates.push(path.join(ctx.jobsDir, `${jobId}.result.md`))
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
    } catch {
      /* keep trying */
    }
  }
  return ''
}

function renderHuman(report, ctx) {
  const lines = []
  lines.push(`jev conflicts — pre-screen for the orchestrator's review; Jev does not decide (${CONFLICTS_CAVEAT})`)
  lines.push(`jobs       ${report.jobs.join(' ')}`)
  lines.push(`pairs      ${report.pairCount} (cap ${PAIRS_MAX})`)
  if (report.conflicts.length === 0) {
    lines.push('no contradictions at or above 0.5')
  }
  report.conflicts.forEach((conflict, index) => {
    lines.push(`${index + 1}. ${conflict.jobA} ↔ ${conflict.jobB}  contradicts=${probability(conflict.contradicts)}  ${conflict.path}`)
    lines.push(`   a: ${conflict.a}`)
    lines.push(`   b: ${conflict.b}`)
  })
  lines.push(CONFLICTS_CAVEAT)
  ctx.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * `jev conflicts <jobId> <jobId> [...] [--json]`.
 * @returns 0 on a report (even one with no pairs), 1 on a read/API error.
 */
export async function runConflicts(positional, flags, ctx) {
  const env = ctx.env
  if (!isEnabled(env)) {
    ctx.stdout.write(`${DISABLED_LINE}\n`)
    return 0
  }
  const jobIds = positional.filter((value) => typeof value === 'string' && value !== '')
  if (jobIds.length < 2) {
    ctx.stderr.write('dsh-offload: jev conflicts requires at least two job ids\n')
    return 1
  }

  const jobFindings = []
  try {
    for (const jobId of jobIds) {
      const job = ctx.readJob(jobId)
      jobFindings.push({ jobId, findings: extractFindings(resultTextFor(jobId, job, ctx)) })
    }
  } catch (error) {
    ctx.stderr.write(`dsh-offload: ${error.message}\n`)
    return 1
  }

  const pairs = planPairs(jobFindings)
  if (pairs.length === 0) {
    const report = {
      kind: 'jev-conflicts',
      synthetic: true,
      jobs: jobIds,
      pairCount: 0,
      conflicts: [],
      caveat: CONFLICTS_CAVEAT,
    }
    if (flags.json === true) ctx.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else renderHuman(report, ctx)
    return 0
  }

  let scored
  try {
    scored = await pool(pairs, CONCURRENCY, async (pair) => {
      const { json } = await callJev({
        state: {
          finding_a: trim(pair.a, SIDE_CHARS),
          finding_b: trim(pair.b, SIDE_CHARS),
        },
        questions: { [CONTRADICTS_ID]: CONTRADICTS_QUESTION },
        env,
      })
      const noul = json.answers?.[CONTRADICTS_ID]?.noul
      return { pair, contradicts: typeof noul === 'number' ? noul : null }
    })
  } catch (error) {
    ctx.stderr.write(`dsh-offload: jev conflicts failed: ${error.message}\n`)
    return 1
  }

  const conflicts = scored
    .filter((entry) => typeof entry.contradicts === 'number' && entry.contradicts >= CONTRADICTS_THRESHOLD)
    .map((entry) => ({
      jobA: entry.pair.jobA,
      jobB: entry.pair.jobB,
      path: entry.pair.path,
      contradicts: entry.contradicts,
      a: trim(entry.pair.a, REPORT_SIDE_CHARS),
      b: trim(entry.pair.b, REPORT_SIDE_CHARS),
    }))
  const report = {
    kind: 'jev-conflicts',
    synthetic: true,
    jobs: jobIds,
    pairCount: pairs.length,
    threshold: CONTRADICTS_THRESHOLD,
    pairsMax: PAIRS_MAX,
    conflicts,
    caveat: CONFLICTS_CAVEAT,
  }
  if (flags.json === true) {
    ctx.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 0
  }
  renderHuman(report, ctx)
  return 0
}
