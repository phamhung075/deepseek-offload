/**
 * Per-job model and thinking effort for `start` and `resume`.
 *
 * The values are validated here, before a job record exists, so a typo fails
 * the command instead of a worker minutes later. The bridge (`deepseek_agent`
 * `model` / `reasoningEffort`) applies them to the session through the ACP
 * session config options; an omitted value keeps the `acp` profile pin and the
 * provider's default effort (high).
 */

/** The DeepSeek API model ids a job may run on. */
export const JOB_MODELS = Object.freeze(['deepseek-flash', 'deepseek-v4-pro'])

/** The thinking efforts a job may ask for; `none` disables thinking. */
export const JOB_EFFORTS = Object.freeze(['none', 'low', 'high', 'max'])

/** A rejected `--model` or `--effort`; the CLI turns it into `fail(message)`. */
export class ModelFlagError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ModelFlagError'
  }
}

/**
 * Resolve a job's model and effort from its flags, falling back to a base
 * record (the job a `resume` continues).
 * @param flags - parsed flags; `model` and `effort` are strings when given.
 * @param base - the record to inherit from, or null.
 * @returns `{ model, effort }`, each null for the default.
 */
export function resolveModelFlags(flags, base = null) {
  const model = pick(flags.model, base?.model)
  const effort = pick(flags.effort, base?.effort)
  if (model !== null && !JOB_MODELS.includes(model)) {
    throw new ModelFlagError(`--model must be one of ${JOB_MODELS.join(', ')} (got ${JSON.stringify(model)})`)
  }
  if (effort !== null && !JOB_EFFORTS.includes(effort)) {
    throw new ModelFlagError(`--effort must be one of ${JOB_EFFORTS.join(', ')} (got ${JSON.stringify(effort)})`)
  }
  return { model, effort }
}

/**
 * The `model` / `effort` lines of `start` and `status`.
 * @param job - a job record.
 * @returns two display lines.
 */
export function describeModelLines(job) {
  const lines = [
    `model     ${job.model ?? 'profile default'}  effort ${job.effort ?? 'default (high)'}`,
  ]
  if (typeof job.modelSelection === 'string') lines.push(`applied   ${job.modelSelection}`)
  return lines
}

function pick(value, fallback) {
  if (typeof value === 'string' && value !== '') return value
  if (typeof fallback === 'string' && fallback !== '') return fallback
  return null
}
