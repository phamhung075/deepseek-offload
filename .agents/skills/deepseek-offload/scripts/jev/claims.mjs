/**
 * Claim check: does the report's own text describe what the cited code says?
 *
 * Code (not Jev) extracts the `path:line` / `path:~line` / `path:line-line`
 * citations and their sentence, then reads ±6 lines at the job's reviewed head
 * with `git show REV:path`. A citation that is not a literal path at REV is
 * resolved against the tracked files by path suffix (`billing/postgres.go` and
 * `postgres.go` each find their unique tracked file; several matches are
 * counted `skipped.ambiguous`). One `noul` question per claim judges whether
 * those lines say what the sentence claims. Instructions, criteria and the 0.3
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
import { CLAIM_SUPPORTED_ID, CLAIM_SUPPORTED_QUESTION, CLAIM_SUPPORT_THRESHOLD } from './questions.mjs'
import { citeRegex } from './paths.mjs'
import { readResultText } from './job-result.mjs'

/** At most this many claims are checked per job. */
export const CLAIMS_MAX = 40

/** Evidence window: ±this many lines around the cited line. */
export const EVIDENCE_RADIUS = 6

/** Truncation bounds from the evaluation's state shape. */
export const CLAIM_TEXT_MAX = 1000
export const EVIDENCE_CHARS_MAX = 2000

/** git read buffer for one cited file or the tracked-file listing. */
export const GIT_MAX_BUFFER = 32 * 1024 * 1024

/** `error.code` `readEvidence` sets when several tracked paths match a citation. */
export const AMBIGUOUS_CITED_PATH = 'AMBIGUOUS_CITED_PATH'

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

/**
 * List the tracked files a citation can be resolved against: the tree at
 * `source.rev` (`git ls-tree -r --name-only REV`) or, for `{worktree: true}`,
 * the index (`git ls-files`). Callers that resolve several citations list this
 * once and hand it back through `readEvidence`'s `trackedFiles` option.
 */
export function listTrackedFiles(repo, source = {}) {
  const args = source?.worktree === true
    ? ['-C', repo, 'ls-files', '-z']
    : ['-C', repo, 'ls-tree', '-r', '--name-only', '-z', `${source?.rev ?? 'HEAD'}`]
  const out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
  return out.split('\0').filter((entry) => entry !== '')
}

/**
 * Resolve a cited path against the tracked files by suffix match on a `/`
 * boundary: a tracked path equal to the citation or ending in `/` + citation
 * (so `handlers_jobs.go` and `billing/postgres.go` find their one tracked file).
 * @returns `{path}` for exactly one match, `{ambiguous: true}` for several, and
 * `null` when none matches.
 */
export function resolveTrackedPath(citedPath, tracked) {
  const needle = String(citedPath ?? '').replace(/^\.\//, '')
  const matches = tracked.filter((file) => file === needle || file.endsWith(`/${needle}`))
  if (matches.length === 1) return { path: matches[0] }
  if (matches.length > 1) return { ambiguous: true }
  return null
}

/**
 * Read ±`radius` numbered lines around `citedPath:line`.
 *
 * The evidence source is explicit: `{rev}` reads that git revision
 * (`git show REV:path`, for `jev claims` at the reviewed head), while
 * `{worktree: true}` reads the file on disk (for the `mcp-jev` self-check of an
 * answer not yet committed). Either way the reader is the server — no caller
 * ever supplies evidence text.
 *
 * The literal citation is tried first. When it does not exist, the path is
 * resolved against the tracked files (a bare `handlers_jobs.go` or a partial
 * `billing/postgres.go` finds its unique tracked file); the resolved path is
 * returned as `path` and the citation as `citedPath`. Several matches throw an
 * error coded `AMBIGUOUS_CITED_PATH`; none rethrows the read failure. An
 * absolute `{worktree: true}` path is read unchanged. `options.trackedFiles` is
 * an optional memoised `() => string[]` so a multi-claim run lists git once.
 * @returns `{path, citedPath, line, lines, fileLines, lo, hi}`; throws when unreadable.
 */
export function readEvidence(repo, source, citedPath, line, radius = EVIDENCE_RADIUS, options = {}) {
  const worktree = source?.worktree === true
  const readAt = (filePath) => (worktree
    ? fs.readFileSync(path.isAbsolute(filePath) ? filePath : path.resolve(repo, filePath), 'utf8')
    : execFileSync('git', ['-C', repo, 'show', `${source?.rev ?? 'HEAD'}:${filePath}`], {
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    }))

  let resolvedPath = citedPath
  let out
  if (worktree && path.isAbsolute(citedPath)) {
    out = readAt(citedPath)
  } else {
    try {
      out = readAt(citedPath)
    } catch (readError) {
      const tracked = typeof options.trackedFiles === 'function' ? options.trackedFiles() : listTrackedFiles(repo, source)
      const resolved = resolveTrackedPath(citedPath, tracked)
      if (resolved === null) throw readError
      if (resolved.ambiguous === true) {
        const error = new Error(`several tracked files match the citation ${citedPath}`)
        error.code = AMBIGUOUS_CITED_PATH
        throw error
      }
      resolvedPath = resolved.path
      out = readAt(resolvedPath)
    }
  }

  const lines = out.split('\n')
  const center = Number.isSafeInteger(line) && line > 0 ? line : 1
  const lo = Math.max(1, center - radius)
  const hi = Math.min(lines.length, center + radius)
  const numbered = []
  for (let n = lo; n <= hi; n++) numbered.push(`${n}: ${lines[n - 1]}`)
  return { path: resolvedPath, citedPath, line: center, lines: numbered.join('\n'), fileLines: lines.length, lo, hi }
}

/**
 * Judge one already-read claim with the one measured question.
 * @param claim - the claim text (truncated to the measured shape).
 * @param evidence - the result of `readEvidence`: `{path, lines}`.
 * @param env - environment carrying the key/endpoint.
 * @returns `{supported, model}`; `supported` is null when Jev returned none.
 */
export async function judgeClaim(claim, evidence, env = process.env) {
  const { json } = await callJev({
    state: {
      claim: trim(claim, CLAIM_TEXT_MAX),
      evidence: { path: evidence.path, lines: trim(evidence.lines, EVIDENCE_CHARS_MAX) },
    },
    questions: { [CLAIM_SUPPORTED_ID]: CLAIM_SUPPORTED_QUESTION },
    env,
  })
  const value = json.answers?.[CLAIM_SUPPORTED_ID]?.noul
  return { supported: typeof value === 'number' ? value : null, model: json.model ?? null }
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
  const skipped = { missingFile: 0, ambiguous: 0, cap: Math.max(0, found.length - selected.length) }
  // The tracked-file listing is computed once, on the first literal-path miss.
  let trackedFiles = null
  const trackedProvider = () => (trackedFiles ??= listTrackedFiles(repo, { rev }))

  const units = []
  for (const claim of selected) {
    if (!Number.isSafeInteger(claim.line) || claim.line < 1) {
      skipped.missingFile++
      continue
    }
    try {
      units.push({
        claim,
        evidence: readEvidence(repo, { rev }, claim.path, claim.line, EVIDENCE_RADIUS, { trackedFiles: trackedProvider }),
      })
    } catch (error) {
      if (error?.code === AMBIGUOUS_CITED_PATH) skipped.ambiguous++
      else skipped.missingFile++
    }
  }

  const base = {
    kind: 'jev-claims',
    generatedAt: new Date().toISOString(),
    jobId,
    repo,
    rev,
    threshold: CLAIM_SUPPORT_THRESHOLD,
    total: found.length,
    considered: units.length,
    skipped,
  }

  if (!isEnabled(env)) {
    return { ...base, state: 'disabled', model: null, unsupported: [], unsupportedCount: 0, claimsFlagged: false }
  }

  let model = null
  const results = await pool(units, CONCURRENCY, async (unit) => {
    const judged = await judgeClaim(unit.claim.sentence, unit.evidence, env)
    model = model ?? judged.model ?? null
    return { unit, score: judged.supported }
  })

  const unsupported = results
    .filter((entry) => typeof entry.score === 'number' && entry.score < CLAIM_SUPPORT_THRESHOLD)
    .map((entry) => ({
      path: entry.unit.evidence.path,
      citedPath: entry.unit.evidence.citedPath,
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
  ctx.stdout.write(`unsupported ${report.unsupportedCount}; skipped ${report.skipped.missingFile} missing file(s), ${report.skipped.ambiguous} ambiguous, ${report.skipped.cap} over the ${CLAIMS_MAX} cap\n`)
  if (report.unsupported.length > 0) {
    ctx.stdout.write('claims to verify:\n')
    for (const claim of report.unsupported) {
      ctx.stdout.write(`  ${claim.path}:${claim.line}  supported=${claim.supported.toFixed(3)}  ${claim.sentence}\n`)
    }
  }
  return EXIT_CLAIMS_OK
}
