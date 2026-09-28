/**
 * Failure triage for a job that ended in `error`.
 *
 * Deterministic rules run first — a regex table whose advice is code, so the
 * common failures never need a model. Only when no rule matches AND Jev is
 * enabled is one `choice` question, `failure_kind`, asked over the error text
 * and the last activity lines. That branch is UNVALIDATED: no labelled set
 * measured it. Triage only advises; it never resumes a job on its own.
 */
import { callJev, isEnabled, DISABLED_LINE } from './client.mjs'
import { FAILURE_KIND_ID, failureKindQuestion } from './questions.mjs'
import { readActivity, WATCH_ACTIVITY_LINES } from './watch.mjs'

export const EXIT_TRIAGE_OK = 0
export const EXIT_TRIAGE_ERROR = 1

/** One stderr line when the Jev fallback runs; the code rules stay standard. */
export const TRIAGE_EXPERIMENTAL =
  'experimental: UNVALIDATED failure_kind fallback; code rules stay standard'

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/** The job's own timeout, so the timeout advice can double it. */
export function timeoutMsFor(job, env = process.env) {
  const jobTimeout = Number(job?.timeoutMs)
  if (Number.isFinite(jobTimeout) && jobTimeout > 0) return jobTimeout
  const envTimeout = Number(env.DEEPSEEK_MCP_TIMEOUT_MS)
  if (Number.isFinite(envTimeout) && envTimeout > 0) return envTimeout
  return DEFAULT_TIMEOUT_MS
}

/**
 * The named, table-driven triage rules. Order matters: the first matching
 * pattern wins, so the specific worker-state and timeout strings come first.
 * Each advice is a function of `{jobId, job, env}`.
 */
export const TRIAGE_RULES = [
  {
    pattern: /worker process .* is gone/i,
    kind: 'interrupted',
    advice: ({ jobId }) => `dsh-offload resume ${jobId}`,
  },
  {
    pattern: /ACP request timed out/i,
    kind: 'timeout',
    advice: ({ jobId, job, env }) => `dsh-offload resume ${jobId} --timeout-ms ${2 * timeoutMsFor(job, env)}`,
  },
  {
    pattern: /EROFS|EACCES|permission denied/i,
    kind: 'environment',
    advice: ({ jobId }) => `fix the environment (path/permissions), then dsh-offload resume ${jobId}`,
  },
  {
    pattern: /HTTP\s*40[13]\b/,
    kind: 'credentials',
    advice: ({ jobId }) => `check the credentials, then dsh-offload resume ${jobId}`,
  },
  {
    pattern: /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/,
    kind: 'network',
    advice: ({ jobId }) => `transient network failure — dsh-offload resume ${jobId}`,
  },
]

/** One line of advice per Jev `failure_kind`, used only on the unvalidated branch. */
export const KIND_ADVICE = {
  transient: (jobId) => `transient failure — dsh-offload resume ${jobId}`,
  environment: (jobId) => `fix the environment, then dsh-offload resume ${jobId}`,
  input: (jobId) => `fix the work order or its inputs, then re-run ${jobId}`,
  implementation: (jobId) => `the worker logic is broken — inspect the diff and logs, then re-run ${jobId}`,
}

/** The text a rule matches against: the job's recorded error, or ''. */
export function errorTextFor(job) {
  const parts = [job?.error, job?.failureReason, job?.stopReason]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
  return parts.join('\n')
}

/** First matching rule for an error string, or null. */
export function matchRule(errorText) {
  return TRIAGE_RULES.find((rule) => rule.pattern.test(errorText)) ?? null
}

/**
 * Triage one failed job.
 * @param jobId - the job.
 * @param job - its record.
 * @param ctx - `{env, projectRoot, sessionTail}`.
 * @returns `{kind, source, advice, detail?, confidence?}` or null when the job
 *   did not fail.
 */
export async function triageJob(jobId, job, ctx = {}) {
  const env = ctx.env ?? process.env
  const errorText = errorTextFor(job)
  if (job?.state !== 'error' && errorText === '') return null

  const rule = matchRule(errorText)
  if (rule !== null) {
    return { kind: rule.kind, source: 'rule', advice: rule.advice({ jobId, job, env }), error: errorText }
  }

  if (!isEnabled(env)) {
    return { kind: 'unknown', source: 'none', advice: `read the worker log and decide; no Jev key is set`, error: errorText }
  }

  // The Jev fallback is the experimental part of triage; warn where it runs.
  if (ctx.stderr && typeof ctx.stderr.write === 'function') ctx.stderr.write(`${TRIAGE_EXPERIMENTAL}\n`)

  let activity = []
  try {
    activity = readActivity(ctx.sessionTail, jobId, ctx.projectRoot, env).slice(-WATCH_ACTIVITY_LINES)
  } catch {
    activity = []
  }
  try {
    const { json } = await callJev({
      state: { error: errorText, last_activity: activity.join('\n') },
      questions: { [FAILURE_KIND_ID]: failureKindQuestion() },
      env,
    })
    const answer = json.answers?.[FAILURE_KIND_ID] ?? {}
    const kind = typeof answer.choice === 'string' ? answer.choice : 'unknown'
    const advice = (KIND_ADVICE[kind] ?? KIND_ADVICE.transient)(jobId)
    return { kind, source: 'jev', advice, confidence: answer.confidence ?? null, unvalidated: true, error: errorText }
  } catch (error) {
    return { kind: 'unknown', source: 'none', advice: `triage call failed (${error.message}); read the worker log`, error: errorText }
  }
}

/** The human block appended to `result`/`wait` for a failed job. */
export function renderTriageBlock(jobId, result) {
  if (result === null || result === undefined) return null
  const lines = ['--- failure triage (advisory; never auto-resumes) ---']
  lines.push(`kind    ${result.kind}`)
  lines.push(`source  ${result.source}${result.unvalidated === true ? ' (UNVALIDATED)' : ''}`)
  lines.push(`advice  ${result.advice}`)
  return lines.join('\n')
}

/**
 * `jev triage <jobId> [--json]`.
 * @returns process exit code.
 */
export async function commandTriage(positional, flags, ctx) {
  const jobId = positional[0]
  if (jobId === undefined) {
    ctx.stderr.write('dsh-offload: jev triage requires a job id\n')
    return EXIT_TRIAGE_ERROR
  }
  const env = ctx.env ?? process.env
  if (!isEnabled(env)) {
    // A rule still fires without a key; only the Jev fallback needs one.
    let job
    try {
      job = ctx.loadJob(jobId)
    } catch (error) {
      ctx.stderr.write(`dsh-offload: ${error.message}\n`)
      return EXIT_TRIAGE_ERROR
    }
    const errorText = errorTextFor(job)
    const rule = errorText === '' ? null : matchRule(errorText)
    if (errorText === '') {
      ctx.stdout.write(`jev triage: job ${jobId} did not end in error (state=${job.state})\n`)
      return EXIT_TRIAGE_OK
    }
    if (rule === null) {
      ctx.stdout.write(`${DISABLED_LINE}\n`)
      return EXIT_TRIAGE_OK
    }
    const result = { kind: rule.kind, source: 'rule', advice: rule.advice({ jobId, job, env }) }
    if (flags.json === true) ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    else ctx.stdout.write(`${renderTriageBlock(jobId, result)}\n`)
    return EXIT_TRIAGE_OK
  }

  let job
  try {
    job = ctx.loadJob(jobId)
  } catch (error) {
    ctx.stderr.write(`dsh-offload: ${error.message}\n`)
    return EXIT_TRIAGE_ERROR
  }
  const result = await triageJob(jobId, job, ctx)
  if (result === null) {
    ctx.stdout.write(`jev triage: job ${jobId} did not end in error (state=${job.state})\n`)
    return EXIT_TRIAGE_OK
  }
  if (flags.json === true) ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else ctx.stdout.write(`${renderTriageBlock(jobId, result)}\n`)
  return EXIT_TRIAGE_OK
}
