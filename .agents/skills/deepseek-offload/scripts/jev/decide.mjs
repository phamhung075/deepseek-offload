/**
 * Decision log: record the orchestrator's accept/reject/partial label for a
 * reviewed job, so the Jev thresholds can later be checked against real labels
 * instead of guessing. Pure local — no Jev call and no API key needed.
 *
 * `jev decide <jobId> accept|reject|partial [--note TEXT]` writes
 * `<jobId>.jev-decision.json` and appends one JSONL line to
 * `<jobsDir>/jev-log.jsonl`. `jev log [--json]` reports counts and the
 * flagged/clean-versus-decision agreement, plus a P(none) what-if at
 * 0.4/0.5/0.6 replayed from the stored reports.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The only accepted labels. */
export const DECISIONS = ['accept', 'reject', 'partial']

/** The append-only JSONL log beside the job records. */
export const LOG_NAME = 'jev-log.jsonl'

/** The P(none) thresholds `log` replays against the stored reviews. */
export const WHATIF_THRESHOLDS = [0.4, 0.5, 0.6]

export const EXIT_DECIDE_OK = 0
export const EXIT_DECIDE_ERROR = 1

/** The decision file for one job. */
export function decisionFile(jobsDir, jobId) {
  return path.join(jobsDir, `${jobId}.jev-decision.json`)
}

/** The shared JSONL log. */
export function logFile(jobsDir) {
  return path.join(jobsDir, LOG_NAME)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** The smallest P(none) among a report's groups, or null. */
export function minPNone(report) {
  let min = null
  for (const group of report?.groups ?? []) {
    if (typeof group.pNone !== 'number') continue
    if (min === null || group.pNone < min) min = group.pNone
  }
  return min
}

/** The review facts one decision records, taken from the job and its report. */
export function reviewSummary(job, jobsDir) {
  const review = job.jevReview ?? {}
  const report = readJson(path.join(jobsDir, `${job.jobId}.jev-review.json`))
  const ruleHits = Array.isArray(report?.rules?.findings)
    ? report.rules.findings.filter((finding) => finding.severity === 'flag').length
    : (typeof review.ruleHits === 'number' ? review.ruleHits : 0)
  return {
    state: review.state ?? 'not-run',
    flaggedGroups: typeof review.flaggedGroups === 'number' ? review.flaggedGroups : null,
    ruleHits,
    claimsFlagged: review.claimsFlagged === true,
    pNoneMin: minPNone(report),
  }
}

/**
 * `jev decide <jobId> accept|reject|partial [--note TEXT]`.
 * @returns process exit code.
 */
export function commandDecide(positional, flags, ctx) {
  const jobId = positional[0]
  const decision = positional[1]
  if (jobId === undefined || decision === undefined) {
    ctx.stderr.write('dsh-offload: jev decide requires <jobId> accept|reject|partial\n')
    return EXIT_DECIDE_ERROR
  }
  if (!DECISIONS.includes(decision)) {
    ctx.stderr.write(`dsh-offload: jev decide label must be one of ${DECISIONS.join('|')}\n`)
    return EXIT_DECIDE_ERROR
  }
  let job
  try {
    job = ctx.loadJob(jobId)
  } catch (error) {
    ctx.stderr.write(`dsh-offload: ${error.message}\n`)
    return EXIT_DECIDE_ERROR
  }

  const entry = {
    jobId,
    label: typeof job.label === 'string' && job.label !== '' ? job.label : null,
    decision,
    note: typeof flags.note === 'string' ? flags.note : null,
    decidedAt: new Date().toISOString(),
    review: reviewSummary(job, ctx.jobsDir),
  }

  try {
    fs.mkdirSync(ctx.jobsDir, { recursive: true })
    if (typeof ctx.writeJsonAtomic === 'function') {
      ctx.writeJsonAtomic(decisionFile(ctx.jobsDir, jobId), entry)
    } else {
      fs.writeFileSync(decisionFile(ctx.jobsDir, jobId), `${JSON.stringify(entry, null, 2)}\n`)
    }
    fs.appendFileSync(logFile(ctx.jobsDir), `${JSON.stringify(entry)}\n`)
  } catch (error) {
    ctx.stderr.write(`dsh-offload: could not record the jev decision: ${error.message}\n`)
    return EXIT_DECIDE_ERROR
  }

  if (flags.json === true) {
    ctx.stdout.write(`${JSON.stringify(entry, null, 2)}\n`)
  } else {
    ctx.stdout.write(`jev decision recorded: ${jobId} ${decision} (review ${entry.review.state}, P(none)min=${format(entry.review.pNoneMin)})\n`)
  }
  return EXIT_DECIDE_OK
}

const format = (value) => (typeof value === 'number' ? value.toFixed(3) : 'n/a')

/** Every logged decision, oldest first; a corrupt line is skipped. */
export function readLog(jobsDir) {
  let text
  try {
    text = fs.readFileSync(logFile(jobsDir), 'utf8')
  } catch {
    return []
  }
  const entries = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      /* a corrupt line is not a reason to fail the whole report */
    }
  }
  return entries
}

function emptyMatrix() {
  return { flaggedRejected: 0, flaggedAccepted: 0, cleanRejected: 0, cleanAccepted: 0 }
}

function tally(entries, isFlagged) {
  const matrix = emptyMatrix()
  let partial = 0
  for (const entry of entries) {
    if (entry.decision === 'partial') {
      partial++
      continue
    }
    if (isFlagged(entry)) matrix[entry.decision === 'reject' ? 'flaggedRejected' : 'flaggedAccepted']++
    else matrix[entry.decision === 'reject' ? 'cleanRejected' : 'cleanAccepted']++
  }
  return { ...matrix, partial }
}

/** Counts and agreement for the logged decisions, plus the P(none) what-if. */
export function summarizeLog(entries) {
  const byDecision = { accept: 0, reject: 0, partial: 0 }
  for (const entry of entries) {
    if (byDecision[entry.decision] !== undefined) byDecision[entry.decision]++
  }
  const agreement = tally(entries, (entry) => entry.review?.state === 'flagged')
  const whatIf = WHATIF_THRESHOLDS.map((threshold) => ({
    threshold,
    ...tally(entries, (entry) => typeof entry.review?.pNoneMin === 'number' && entry.review.pNoneMin < threshold),
  }))
  return { total: entries.length, byDecision, agreement, whatIf }
}

/**
 * `jev log [--json]`.
 * @returns process exit code.
 */
export function commandLog(positional, flags, ctx) {
  const entries = readLog(ctx.jobsDir)
  const summary = summarizeLog(entries)
  if (flags.json === true) {
    ctx.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return EXIT_DECIDE_OK
  }
  ctx.stdout.write(`jev log — ${summary.total} decision(s): accept ${summary.byDecision.accept}, reject ${summary.byDecision.reject}, partial ${summary.byDecision.partial}\n`)
  const a = summary.agreement
  ctx.stdout.write(`agreement (Jev flagged x decision): flagged&rejected ${a.flaggedRejected}, flagged&accepted ${a.flaggedAccepted}, clean&rejected ${a.cleanRejected}, clean&accepted ${a.cleanAccepted}\n`)
  ctx.stdout.write('what-if by P(none) threshold (stored reports):\n')
  for (const row of summary.whatIf) {
    ctx.stdout.write(`  < ${row.threshold.toFixed(1)}: flagged&rejected ${row.flaggedRejected}, flagged&accepted ${row.flaggedAccepted}, clean&rejected ${row.cleanRejected}, clean&accepted ${row.cleanAccepted}\n`)
  }
  return EXIT_DECIDE_OK
}
