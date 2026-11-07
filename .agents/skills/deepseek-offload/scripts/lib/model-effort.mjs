/**
 * Per-job model and thinking effort for `start` and `resume`.
 *
 * The values are validated here, before a job record exists, so a typo fails
 * the command instead of a worker minutes later. The bridge (`deepseek_agent`
 * `model` / `reasoningEffort`) applies them to the session through the ACP
 * session config options; an omitted value keeps the `acp` profile pin and the
 * provider's default effort (high).
 */

import { createRequire } from 'node:module'

// The shared model policy (owner ruling 2026-11-07: no deepseek-v4-pro).
const policy = createRequire(import.meta.url)('../../../../mcp-deepseek/model-policy.cjs')

/** The DeepSeek API model ids a job may run on. */
export const JOB_MODELS = policy.ALLOWED_MODELS
export const SAFE_MODEL = policy.SAFE_MODEL
export const isBlockedModel = policy.isBlockedModel

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
 * @returns `{ model, effort, notice }`, model/effort null for the default;
 *   `notice` is set when an inherited blocked model was replaced.
 *
 * An explicit `--model` naming a pro id is refused. A `resume` whose base
 * record ran on a pro id (before the 2026-11-07 block) continues on
 * SAFE_MODEL instead: the work goes on, and the bridge would refuse to keep
 * the session on pro anyway.
 */
export function resolveModelFlags(flags, base = null) {
  const explicit = pick(flags.model, null)
  let model = pick(flags.model, base?.model)
  const effort = pick(flags.effort, base?.effort)
  let notice = null
  if (explicit === null && model !== null && isBlockedModel(model)) {
    notice = `the original job ran on ${model}; ${policy.PRO_RULING}, so this resume runs on ${SAFE_MODEL}`
    model = SAFE_MODEL
  }
  if (model !== null) {
    const refusal = policy.modelRefusal(model, '--model')
    if (refusal !== null) throw new ModelFlagError(refusal)
  }
  if (effort !== null && !JOB_EFFORTS.includes(effort)) {
    throw new ModelFlagError(`--effort must be one of ${JOB_EFFORTS.join(', ')} (got ${JSON.stringify(effort)})`)
  }
  return { model, effort, notice }
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
