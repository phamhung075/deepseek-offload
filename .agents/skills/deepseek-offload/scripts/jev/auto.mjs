/**
 * Automatic `jev review` around a background job: the pre-screen runs in the
 * worker the moment the job settles, so `result` / `wait` hand the orchestrator
 * a report that is already screened.
 *
 * This module owns everything the auto-review adds; `dsh-offload.mjs` only
 * wires it in, because the runner is large and this is optional behaviour:
 *
 *   - resolve the review clone and its start commit from `start`/`resume`
 *     flags (a bad value warns and leaves the job without auto-review — a
 *     broken review must never block a start);
 *   - run the review in-process with `runReview`, capturing its output in a
 *     string buffer instead of the terminal;
 *   - render the compact verdict block `result` / `wait` prints.
 *
 * Jev is optional: without a key the record degrades to `state: 'disabled'`
 * and no request is made.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isEnabled, probability } from './client.mjs'
import { runReview, EXIT_CLEAN, EXIT_FLAGGED } from './review.mjs'
import { runClaims, extractClaims, readClaimsReport } from './claims.mjs'
import { readResultText } from './job-result.mjs'
import { UNTRACKED_SHA, WORKTREE_SHA } from './diff.mjs'

/** Bound the whole in-process review; a slow API must not hold the worker forever. */
export const AUTO_REVIEW_TIMEOUT_MS = 180_000

/** Poll interval while `wait` waits for the worker's review to land. */
export const AUTO_REVIEW_POLL_MS = 500

/** One line every result/wait prints when Jev is not configured. */
export const REVIEW_DISABLED_LINE = 'jev review: disabled — set TYPESAFE_API_KEY'

/** One line while the worker is still reviewing a settled job. */
export const REVIEW_RUNNING_LINE = 'jev review: running'

/** Header of the compact block rendered from a stored report. */
export const REVIEW_BLOCK_HEADER = '--- jev review (pre-screen; the orchestrator still reviews every diff) ---'

/** `runReview` prints this prefix when the range holds no changes to judge. */
const NO_CHANGES_MARKER = 'no changes in'

/** `git rev-parse --show-toplevel` output is a full path, never shorter than this. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024

const firstLine = (text) => String(text ?? '').split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The report file `runReview` writes for a job. */
function reportFile(jobsDir, jobId) {
  return path.join(jobsDir, `${jobId}.jev-review.json`)
}

/** Read the stored report, or null when it is absent or unreadable. */
export function readReport(jobsDir, jobId) {
  try {
    return JSON.parse(fs.readFileSync(reportFile(jobsDir, jobId), 'utf8'))
  } catch {
    return null
  }
}

/** Store the report path the way `resultFile` is stored: relative to the project root. */
function storedReportPath(projectRoot, jobsDir, jobId) {
  const absolute = reportFile(jobsDir, jobId)
  return typeof projectRoot === 'string' && projectRoot !== '' ? path.relative(projectRoot, absolute) : absolute
}

/** Resolve a directory to the git work-tree root it belongs to, or null. */
export function resolveReviewRepo(dir) {
  if (typeof dir !== 'string' || dir === '') return null
  const absolute = path.resolve(dir)
  const out = spawnSync('git', ['-C', absolute, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER })
  if (out.error || out.status !== 0) return null
  const top = out.stdout.trim()
  return top === '' ? null : top
}

/** Resolve a revision to its full commit id in `repo`, or null. */
export function resolveReviewBase(repo, rev) {
  const out = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', rev], { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER })
  if (out.error || out.status !== 0) return null
  const sha = out.stdout.trim()
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null
}

/**
 * Resolve one explicit review target (`--review-repo` / the env default), warning
 * and yielding no review when the directory or the base revision cannot resolve.
 * @returns `{reviewRepo, reviewBase}`, both null when there is nothing to review.
 */
function resolveTarget(dirArg, baseArg, warn) {
  if (dirArg === null) return { reviewRepo: null, reviewBase: null }
  const reviewRepo = resolveReviewRepo(dirArg)
  if (reviewRepo === null) {
    warn(`${dirArg} is not a git work tree; the job runs without auto-review`)
    return { reviewRepo: null, reviewBase: null }
  }
  const rev = typeof baseArg === 'string' && baseArg !== '' ? baseArg : 'HEAD'
  const reviewBase = resolveReviewBase(reviewRepo, rev)
  if (reviewBase === null) {
    warn(`cannot resolve ${rev} in ${reviewRepo}; the job runs without auto-review`)
    return { reviewRepo: null, reviewBase: null }
  }
  return { reviewRepo, reviewBase }
}

/** The env-default review directory, or null. */
function envReviewRepo(env) {
  const value = env && env.DSH_OFFLOAD_REVIEW_REPO
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Resolve `start`'s review target: `--review-repo DIR` (or the
 * `DSH_OFFLOAD_REVIEW_REPO` default), `--review-base REV` defaulting to HEAD at
 * start time, and `--no-jev-review` forcing none. There is deliberately no
 * `--cwd` fallback: a job usually changes a separate clone.
 */
export function resolveStartReviewTarget({ flags, env, warn = () => {} }) {
  if (flags['no-jev-review'] === true) return { reviewRepo: null, reviewBase: null }
  const dirArg = typeof flags['review-repo'] === 'string' ? flags['review-repo'] : envReviewRepo(env)
  return resolveTarget(dirArg, flags['review-base'], warn)
}

/**
 * Resolve `resume`'s review target. The resumed job copies the source record's
 * `reviewRepo`/`reviewBase` (the base stays the original start commit) unless
 * the resume passes its own `--review-repo`/`--review-base`; `--no-jev-review`
 * clears both.
 */
export function resolveResumeReviewTarget({ flags, env, source, warn = () => {} }) {
  if (flags['no-jev-review'] === true) return { reviewRepo: null, reviewBase: null }
  const explicitRepo = typeof flags['review-repo'] === 'string' ? flags['review-repo'] : null
  const sourceRepo = source && typeof source.reviewRepo === 'string' ? source.reviewRepo : null
  if (explicitRepo === null && sourceRepo !== null) {
    let reviewBase = source.reviewBase ?? null
    if (typeof flags['review-base'] === 'string' && flags['review-base'] !== '') {
      const resolved = resolveReviewBase(sourceRepo, flags['review-base'])
      if (resolved === null) warn(`cannot resolve ${flags['review-base']} in ${sourceRepo}; keeping ${reviewBase ?? 'no base'}`)
      else reviewBase = resolved
    }
    return { reviewRepo: sourceRepo, reviewBase }
  }
  const dirArg = explicitRepo !== null ? explicitRepo : envReviewRepo(env)
  return resolveTarget(dirArg, flags['review-base'], warn)
}

/** Reject `promise` after `ms` so a slow review is recorded as an error, not awaited forever. */
function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`auto-review timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Run the pre-screen for a settled job in-process and reduce the report to the
 * small record stored on the job.
 * @param jobId - job whose diff is reviewed; also keys the report file.
 * @param job - record carrying `reviewRepo` and `reviewBase`.
 * @param ctx - `{readJob, jobsDir, writeJsonAtomic, env, projectRoot, timeoutMs}`.
 * @returns `{state, flaggedGroups, groups, meanInScope, reportFile, finishedAt, error?}`.
 */
export async function runAutoReview(jobId, job, ctx) {
  if (!isEnabled(ctx.env)) return { state: 'disabled', finishedAt: Date.now() }
  if (typeof job.reviewRepo !== 'string' || typeof job.reviewBase !== 'string') {
    return { state: 'error', error: 'the job has no review repo/base', finishedAt: Date.now() }
  }

  // Capture every write runReview makes: the review must not print to the
  // worker's stdout, and its message is the error text when it fails.
  const captured = { text: '' }
  const reviewCtx = {
    readJob: ctx.readJob,
    jobsDir: ctx.jobsDir,
    writeJsonAtomic: ctx.writeJsonAtomic,
    env: ctx.env,
    stdout: { write: (chunk) => { captured.text += chunk } },
    stderr: { write: (chunk) => { captured.text += chunk } },
  }

  let code
  try {
    code = await withTimeout(
      runReview([jobId], { repo: job.reviewRepo, base: job.reviewBase }, reviewCtx),
      ctx.timeoutMs ?? AUTO_REVIEW_TIMEOUT_MS,
    )
  } catch (error) {
    return { state: 'error', error: firstLine(error && error.message ? error.message : String(error)), finishedAt: Date.now() }
  }

  if (code !== EXIT_CLEAN && code !== EXIT_FLAGGED) {
    return { state: 'error', error: firstLine(captured.text) || `jev review exited ${code}`, finishedAt: Date.now() }
  }
  if (captured.text.includes(NO_CHANGES_MARKER)) return { state: 'empty', finishedAt: Date.now() }

  const report = readReport(ctx.jobsDir, jobId)
  if (report === null) return { state: 'empty', finishedAt: Date.now() }

  // Claims are a separate signal: they never change the diff verdict, only
  // `claimsFlagged`. They run only when the result text actually cites code.
  let claimsFlagged = false
  let claimsConsidered = 0
  let claimsUnsupported = 0
  try {
    const text = readResultText(jobId, job, ctx)
    if (text !== '' && extractClaims(text).length > 0) {
      const claims = await runClaims(jobId, job, ctx, { repo: job.reviewRepo })
      claimsFlagged = claims.claimsFlagged === true
      claimsConsidered = claims.considered ?? 0
      claimsUnsupported = claims.unsupportedCount ?? 0
    }
  } catch {
    /* claims are advisory; a failure never changes the review */
  }

  return {
    state: report.flagged === true ? 'flagged' : 'clean',
    flaggedGroups: Array.isArray(report.groups) ? report.groups.filter((group) => group.verdict === 'flagged').length : 0,
    groups: Array.isArray(report.groups) ? report.groups.length : 0,
    meanInScope: typeof report.meanInScope === 'number' ? report.meanInScope : null,
    ruleHits: typeof report.ruleHits === 'number' ? report.ruleHits : 0,
    claimsFlagged,
    claimsConsidered,
    claimsUnsupported,
    reportFile: storedReportPath(ctx.projectRoot, ctx.jobsDir, jobId),
    finishedAt: Date.now(),
  }
}

/**
 * Read the stored review off a job, waiting for a still-running worker's review
 * when asked, computing it on demand once when there is no live worker.
 * @param jobId - job being read.
 * @param job - its current record.
 * @param opts - `{wait, workerAlive, updateJob, ...runAutoReview ctx}`.
 * @returns the job record, with `jevReview` filled in when a review applies.
 */
export async function ensureJevReview(jobId, job, opts) {
  if (typeof job.reviewRepo !== 'string' || job.reviewRepo === '') return job
  if (job.jevReview) return job

  // The worker writes its final state before it reviews, so a settled job whose
  // worker is still alive has the review in flight.
  if (opts.workerAlive(job)) {
    if (opts.wait !== true) return { ...job, jevReview: { state: 'running' } }
    const deadline = Date.now() + (opts.timeoutMs ?? AUTO_REVIEW_TIMEOUT_MS)
    while (Date.now() < deadline) {
      await sleep(AUTO_REVIEW_POLL_MS)
      const fresh = opts.readJob(jobId)
      if (fresh.jevReview) return fresh
      if (!opts.workerAlive(fresh)) break
    }
    const fresh = opts.readJob(jobId)
    if (fresh.jevReview) return fresh
    if (opts.workerAlive(fresh)) return { ...fresh, jevReview: { state: 'running' } }
    job = fresh
  }

  try {
    const jevReview = await runAutoReview(jobId, job, opts)
    return opts.updateJob(jobId, { jevReview })
  } catch (error) {
    return { ...job, jevReview: { state: 'error', error: firstLine(error && error.message ? error.message : String(error)), finishedAt: Date.now() } }
  }
}

/**
 * A group label for the block: synthetic groups keep their whole name, commits
 * are shortened to the usual 7 characters.
 */
const SYNTHETIC_SHAS = new Set([UNTRACKED_SHA, WORKTREE_SHA])
const shortSha = (sha) => (SYNTHETIC_SHAS.has(sha) ? sha : String(sha ?? 'unknown').slice(0, 7))

/**
 * Render the compact block `result` / `wait` appends for a settled job. The
 * verdict lines come from the stored report, so the block can be reproduced
 * without calling Jev again.
 * @returns the block text, or null when there is nothing to show.
 */
export function renderJevBlock(jevReview, { jobsDir, jobId }) {
  if (jevReview === null || jevReview === undefined) return null
  if (jevReview.state === 'disabled') return REVIEW_DISABLED_LINE
  if (jevReview.state === 'running') return REVIEW_RUNNING_LINE
  if (jevReview.state === 'empty') return 'jev review: no changes in the review range'
  if (jevReview.state === 'error') return `jev review: error — ${jevReview.error ?? 'unknown error'}`

  const report = readReport(jobsDir, jobId)
  if (report === null) return `jev review: ${jevReview.state} (report missing)`

  const lines = [REVIEW_BLOCK_HEADER]
  for (const finding of report.rules?.findings ?? []) {
    lines.push(`rule  ${finding.severity}  ${finding.message}  ${finding.file} ${finding.range}`)
  }
  if (report.rules?.configWarning) lines.push(`rule  config warning: ${report.rules.configWarning}`)
  if (report.rules?.pathScope?.skipped) lines.push(`rule  pathScope skipped — ${report.rules.pathScope.reason ?? 'no paths in the work order'}`)
  if (Array.isArray(report.rules?.ignored) && report.rules.ignored.length > 0) {
    for (const ignored of report.rules.ignored) lines.push(`rule  ignored by ignorePaths  ${ignored.file}`)
  }
  for (const group of report.groups ?? []) {
    let line = `${shortSha(group.sha)}  ${group.verdict}  P(none)=${probability(group.pNone)}`
    if (group.chosen !== null && group.chosen !== undefined) {
      line += `  chosen ${group.chosen.id} ${group.chosen.file} ${group.chosen.range}`
    }
    lines.push(line)
  }
  const lookHere = report.lookHere ?? []
  if (lookHere.length === 0) {
    lines.push('look here (none)')
  } else {
    lines.push('look here:')
    for (const entry of lookHere) {
      const reason = entry.reason ? `  (${entry.reason})` : ''
      lines.push(`  ${probability(entry.inScope)}  ${entry.file} ${entry.range}${reason}`)
    }
  }
  if (jevReview.claimsFlagged === true) {
    const claims = readClaimsReport(jobsDir, jobId)
    const unsupported = claims?.unsupported ?? []
    lines.push(`claims to verify (${unsupported.length}/${claims?.considered ?? 0} unsupported; not a diff verdict):`)
    for (const claim of unsupported) {
      const sentence = String(claim.sentence ?? '').replace(/\s+/g, ' ').slice(0, 120)
      lines.push(`  ${claim.path}:${claim.line}  supported=${probability(claim.supported)}  ${sentence}`)
    }
  }
  lines.push(`report: ${jevReview.reportFile ?? reportFile(jobsDir, jobId)}`)
  return lines.join('\n')
}
