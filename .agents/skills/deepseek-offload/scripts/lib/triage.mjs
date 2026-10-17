/**
 * Failure triage for a job that ended in `error`.
 *
 * Deterministic rules run first — a regex table whose advice is code, so the
 * common failures get an immediate next step without a model. Triage only
 * advises; it never resumes a job on its own.
 */

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
 * @param ctx - `{env}`.
 * @returns `{kind, source, advice, error}` or null when the job did not fail.
 */
export function triageJob(jobId, job, ctx = {}) {
  const env = ctx.env ?? process.env
  const errorText = errorTextFor(job)
  if (job?.state !== 'error' && errorText === '') return null

  const rule = matchRule(errorText)
  if (rule !== null) {
    return { kind: rule.kind, source: 'rule', advice: rule.advice({ jobId, job, env }), error: errorText }
  }
  return { kind: 'unknown', source: 'none', advice: 'read the worker log and decide', error: errorText }
}

/** The human block appended to `result`/`wait` for a failed job. */
export function renderTriageBlock(jobId, result) {
  if (result === null || result === undefined) return null
  const lines = ['--- failure triage (advisory; never auto-resumes) ---']
  lines.push(`kind    ${result.kind}`)
  lines.push(`source  ${result.source}`)
  lines.push(`advice  ${result.advice}`)
  return lines.join('\n')
}
