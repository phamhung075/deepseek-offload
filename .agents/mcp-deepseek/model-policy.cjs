'use strict'
/**
 * The one model policy of deepseek-offload: which DeepSeek models a delegated
 * job may run on. The runner (`dsh-offload.mjs`), the MCP bridge (`server.cjs`)
 * and the installer (`install/configure.mjs`) all read it, so none of them can
 * offer a model the others refuse.
 *
 * Owner ruling 2026-11-07: never use deepseek-v4-pro. On 2026-11-07, 21 of 51
 * jobs ran on v4-pro at effort high/max and the bill doubled while usage fell
 * under a third. Every "pro" id is refused in code, not left to habit: no flag,
 * environment variable, profile pin or resumed session can select one.
 */

/** The only model ids a job may ask for. */
const ALLOWED_MODELS = Object.freeze(['deepseek-flash'])

/** The model a job runs on when its record or session names a blocked one. */
const SAFE_MODEL = 'deepseek-flash'

/** The ruling the refusal names. */
const PRO_RULING = 'deepseek-v4-pro is blocked by owner ruling 2026-11-07 ("Never use deepseek-v4-pro")'

/**
 * Whether a model id names a "pro" model: a `pro` token in any segment,
 * case-insensitive, with or without a provider prefix (`deepseek-v4-pro`,
 * `deepseek-official/deepseek-v4-pro`, `DeepSeek-V4-Pro`, `["deepseek-official","deepseek-v4-pro"]`).
 * @param id - a model id, provider/model pair, or anything else.
 * @returns true for a pro id.
 */
function isBlockedModel(id) {
  if (typeof id !== 'string') return false
  return /(^|[^a-z0-9])pro([^a-z0-9]|$)/i.test(id)
}

/**
 * The refusal for a requested model.
 * @param id - the requested id.
 * @param flag - how the caller spells the option (`--model`, `model`).
 * @returns the message, or null when the id is allowed.
 */
function modelRefusal(id, flag = '--model') {
  if (isBlockedModel(id)) {
    return `${flag} ${id} refused: ${PRO_RULING}. Use ${flag} ${SAFE_MODEL} (or omit it for the profile pin).`
  }
  if (!ALLOWED_MODELS.includes(id)) {
    return `${flag} must be one of ${ALLOWED_MODELS.join(', ')} (got ${JSON.stringify(id)})`
  }
  return null
}

module.exports = { ALLOWED_MODELS, SAFE_MODEL, PRO_RULING, isBlockedModel, modelRefusal }
