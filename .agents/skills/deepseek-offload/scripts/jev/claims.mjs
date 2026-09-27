/**
 * Claim check: does the report's own text describe what the cited code says?
 *
 * Code (not Jev) extracts the `path:line` / `path:~line` / `path:line-line`
 * citations and their sentence, then reads ±6 lines at the job's reviewed head
 * with `git show REV:path`. One `noul` question per claim judges whether those
 * lines say what the sentence claims. Instructions, criteria and the 0.3
 * threshold are copied from the known-answer evaluation (2026-09-27: AUC 0.950,
 * precision 0.905 / recall 0.826).
 *
 * An unsupported claim is listed under "claims to verify"; it does NOT flag the
 * diff review (a different signal) but sets `jevReview.claimsFlagged`.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { callJev, isEnabled, DISABLED_LINE, pool, CONCURRENCY } from './client.mjs'
import { CLAIM_SUPPORTED_ID, CLAIM_SUPPORTED_QUESTION } from './questions.mjs'
import { citeRegex } from './paths.mjs'
import { readResultText } from './job-result.mjs'

/** At most this many claims are checked per job. */
export const CLAIMS_MAX = 40

/** Evidence window: ±this many lines around the cited line. */
export const EVIDENCE_RADIUS = 6

/** Truncation bounds from the evaluation's state shape. */
export const CLAIM_TEXT_MAX = 1000
export const EVIDENCE_CHARS_MAX = 2000

/** Flag a claim unsupported when `supported` is below this (measured). */
export const SUPPORTED_THRESHOLD = 0.3

export const EXIT_CLAIMS_OK = 0
export const EXIT_CLAIMS_ERROR = 1

/** Truncate model input to the measured state shape, marking the cut. */
const trim = (text, max) => (typeof text === 'string' && text.length > max ? `${text.slice(0, max)}\n...[TRUNCATED]` : text)

/** Split text into sentence-ish units, keeping the newline boundaries. */
export function sentences(text) {
  const out = []
  const source = String(text ?? '')
  let start = 0
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === '\n') {
      out.push(source.slice(start, index))
      start = index + 1
      continue
    }
    if (char === '.' || char === '!' || char === '?') {
      const next = source[index + 1]
      if (next === undefined || /\s/.test(next)) {
        out.push(source.slice(start, index + 1))
        start = index + 1
      }
    }
  }
  if (start < source.length) out.push(source.slice(start))
  return out
}

/**
 * Extract `path:line` citations with the sentence that carries each one.
 * @returns `{path, line, endLine, sentence, quote}[]`, deduped by path+line.
 */
export function extractClaims(text) {
  const claims = []
  const seen = new Set()
  for (const rawSentence of sentences(text)) {
    const sentence = rawSentence.trim()
    if (sentence === '') continue
    for (const match of sentence.matchAll(citeRegex())) {
      const citedPath = match[1].replace(/^\.\//, '')
      const line = Number(match[2])
      const endLine = match[3] === undefined ? null : Number(match[3])
      const key = `${citedPath}:${line}`
      if (seen.has(key)) continue
      seen.add(key)
      claims.push({ path: citedPath, line, endLine, sentence, quote: match[0] })
    }
  }
  return claims
}

/** Read ±`radius` numbered lines at `rev:citedPath`; throws when unreadable. */
export function readEvidence(repo, rev, citedPath, line, radius = EVIDENCE_RADIUS) {
  const out = execFileSync('git', ['-C', repo, 'show', `${rev}:${citedPath}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const lines = out.split('\n')
  const center = Number.isSafeInteger(line) && line > 0 ? line : 1
  const lo = Math.max(1, center - radius)
  const hi = Math.min(lines.length, center + radius)
  const numbered = []
  for (let n = lo; n <= hi; n++) numbered.push(`${n}: ${lines[n - 1]}`)
  return { path: citedPath, line: center, lines: numbered.join('\n'), fileLines: lines.length, lo, hi }
}

/** The stored claim report for a job, or null. */
export function readClaimsReport(jobsDir, jobId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.jev-claims.json`), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Check a job's claims against the code they cite.
 * @param jobId - job whose result text carries the claims.
 * @param job - record carrying `reviewRepo` (the default repo).
 * @param ctx - `{env, jobsDir, projectRoot, writeJsonAtomic}`.
 * @param opts - `{repo, rev, text}`; `rev` defaults to the reviewed head (`HEAD`).
 * @returns the report object; `state: 'disabled'` without a key.
 */
export async function runClaims(jobId, job, ctx, opts = {}) {
  const env = ctx.env ?? process.env
  const repo = opts.repo ?? (typeof job.reviewRepo === 'string' ? job.reviewRepo : null)
  if (repo === null || repo === '') throw new Error('jev claims requires --repo DIR (or a job reviewRepo)')
  const rev = typeof opts.rev === 'string' && opts.rev !== '' ? opts.rev : 'HEAD'
  const text = typeof opts.text === 'string' ? opts.text : readResultText(jobId, job, ctx)

  const found = extractClaims(text)
  const selected = found.slice(0, CLAIMS_MAX)
  const skipped = { missingFile: 0, cap: Math.max(0, found.length - selected.length) }

  const units = []
  for (const claim of selected) {
    if (!Number.isSafeInteger(claim.line) || claim.line < 1) {
      skipped.missingFile++
      continue
    }
    try {
      units.push({ claim, evidence: readEvidence(repo, rev, claim.path, claim.line) })
    } catch {
      skipped.missingFile++
    }
  }

  const base = {
    kind: 'jev-claims',
    generatedAt: new Date().toISOString(),
    jobId,
    repo,
    rev,
    threshold: SUPPORTED_THRESHOLD,
    total: found.length,
    considered: units.length,
    skipped,
  }

  if (!isEnabled(env)) {
    return { ...base, state: 'disabled', model: null, unsupported: [], unsupportedCount: 0, claimsFlagged: false }
  }

  let model = null
  const results = await pool(units, CONCURRENCY, async (unit) => {
    const { json } = await callJev({
      state: {
        claim: trim(unit.claim.sentence, CLAIM_TEXT_MAX),
        evidence: { path: unit.evidence.path, lines: trim(unit.evidence.lines, EVIDENCE_CHARS_MAX) },
      },
      questions: { [CLAIM_SUPPORTED_ID]: CLAIM_SUPPORTED_QUESTION },
      env,
    })
    model = model ?? json.model ?? null
    return { unit, score: json.answers?.[CLAIM_SUPPORTED_ID]?.noul ?? null }
  })

  const unsupported = results
    .filter((entry) => typeof entry.score === 'number' && entry.score < SUPPORTED_THRESHOLD)
    .map((entry) => ({
      path: entry.unit.evidence.path,
      line: entry.unit.evidence.line,
      endLine: entry.unit.claim.endLine,
      sentence: entry.unit.claim.sentence,
      quote: entry.unit.claim.quote,
      supported: entry.score,
    }))

  return {
    ...base,
    state: 'checked',
    model,
    unsupported,
    unsupportedCount: unsupported.length,
    claimsFlagged: unsupported.length > 0,
  }
}

/**
 * `jev claims <jobId> --repo DIR [--rev REV] [--json]`.
 * @returns process exit code.
 */
export async function commandClaims(positional, flags, ctx) {
  const jobId = positional[0]
  if (jobId === undefined) {
    ctx.stderr.write('dsh-offload: jev claims requires a job id\n')
    return EXIT_CLAIMS_ERROR
  }
  let job
  try {
    job = ctx.loadJob(jobId)
  } catch (error) {
    ctx.stderr.write(`dsh-offload: ${error.message}\n`)
    return EXIT_CLAIMS_ERROR
  }
  const repo = typeof flags.repo === 'string' ? flags.repo : (job.reviewRepo ?? null)
  if (repo === null) {
    ctx.stderr.write('dsh-offload: jev claims requires --repo DIR\n')
    return EXIT_CLAIMS_ERROR
  }

  let report
  try {
    report = await runClaims(jobId, job, ctx, { repo, rev: typeof flags.rev === 'string' ? flags.rev : undefined })
  } catch (error) {
    ctx.stderr.write(`dsh-offload: jev claims failed: ${error.message}\n`)
    return EXIT_CLAIMS_ERROR
  }

  if (report.state === 'disabled') {
    ctx.stdout.write(`${DISABLED_LINE}\n`)
    return EXIT_CLAIMS_OK
  }
  if (typeof ctx.writeJsonAtomic === 'function' && typeof ctx.jobsDir === 'string') {
    try {
      ctx.writeJsonAtomic(path.join(ctx.jobsDir, `${jobId}.jev-claims.json`), report)
    } catch (error) {
      ctx.stderr.write(`dsh-offload: could not write the jev claims report: ${error.message}\n`)
    }
  }

  if (flags.json === true) {
    ctx.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return EXIT_CLAIMS_OK
  }
  ctx.stdout.write(`jev claims — ${report.considered}/${report.total} citation(s) checked at ${report.rev}; threshold ${report.threshold}\n`)
  ctx.stdout.write(`unsupported ${report.unsupportedCount}; skipped ${report.skipped.missingFile} missing file(s), ${report.skipped.cap} over the ${CLAIMS_MAX} cap\n`)
  if (report.unsupported.length > 0) {
    ctx.stdout.write('claims to verify:\n')
    for (const claim of report.unsupported) {
      ctx.stdout.write(`  ${claim.path}:${claim.line}  supported=${claim.supported.toFixed(3)}  ${claim.sentence}\n`)
    }
  }
  return EXIT_CLAIMS_OK
}
