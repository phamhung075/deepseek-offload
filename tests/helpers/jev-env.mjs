/**
 * One place that strips every ambient Jev variable before a test builds the
 * environment for a spawned runner or MCP server.
 *
 * These tests point `TYPESAFE_API_URL` at their own local stub and opt into a
 * feature with an explicit flag or env value. An ambient variable from the
 * caller's shell must never decide the child's behaviour: `DSH_OFFLOAD_JEV_LINT=1`
 * would make an ordinary `start` lint, an ambient `TYPESAFE_API_KEY` would let
 * the stub-only tests reach the real API, and `TYPESAFE_API_URL` would redirect
 * the stub tests elsewhere. A test that wants one of these sets it explicitly
 * after calling `jevFreeEnv`.
 *
 * The list mirrors what the code actually reads: `TYPESAFE_*` and
 * `DSH_OFFLOAD_JEV_ROLES` in `scripts/jev/`, the rest in `dsh-offload.mjs`
 * (see `--help`).
 */
export const JEV_ENV_VARS = Object.freeze([
  'TYPESAFE_API_KEY',
  'TYPESAFE_AI_API',
  'TYPESAFE_API_URL',
  'DSH_OFFLOAD_JEV_LINT',
  'DSH_OFFLOAD_JEV_WATCH',
  'DSH_OFFLOAD_JEV_CONFIG',
  'DSH_OFFLOAD_JEV_ROLES',
  'DSH_OFFLOAD_REVIEW_REPO',
  'DSH_OFFLOAD_SESSION_TAIL',
])

/**
 * A copy of the ambient environment with no Jev variable, then `overrides`
 * applied on top. Tests pass only the non-Jev values they need.
 */
export function jevFreeEnv(overrides = {}) {
  const env = { ...process.env }
  for (const name of JEV_ENV_VARS) delete env[name]
  return Object.assign(env, overrides)
}
