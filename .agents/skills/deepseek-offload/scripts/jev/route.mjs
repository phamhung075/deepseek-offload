/**
 * `jev route` — suggest which engineering role should own a work order, and
 * whether the work wants a background job or can wait for off-peak pricing.
 *
 * This command SUGGESTS: it never dispatches, and the orchestrator decides. One
 * Jev request carries one `fits_role_v2` noul per role (the wording the
 * known-answer evaluation measured, 2026-09-27) plus two UNVALIDATED nouls,
 * `can_defer` and `needs_background`.
 *
 * Roles come from a JSON file — `[{"name": "...", "mission": "..."}]` — at
 * `<projectRoot>/.agents/jev-roles.json` unless `--roles-file F` or
 * `DSH_OFFLOAD_JEV_ROLES` names another file. Without one the command prints how
 * to create it and exits 0.
 */
import fs from 'node:fs'
import path from 'node:path'
import { callJev, isEnabled, DISABLED_LINE, probability } from './client.mjs'
import { FITS_ROLE_V2, CAN_DEFER, NEEDS_BACKGROUND } from './questions.mjs'

/**
 * The measured caveat. Printed with every suggestion, and stored on the JSON
 * report, so no caller mistakes the ranking for a dispatch.
 */
export const ROUTE_CAVEAT =
  'routing measured 40.9% top-1 / 54.5% top-2 on 22 work orders — a suggestion for the orchestrator, not a dispatch'

/** A role with a `fits_role_v2` probability at or above this is suggested. */
export const FITS_SUGGEST = 0.5

/** The advice cutoff for the two unvalidated follow-up nouls. */
export const ADVICE_THRESHOLD = 0.5

/** The default roles file, relative to the project the runner belongs to. */
export const ROLES_FILENAME = path.join('.agents', 'jev-roles.json')

/** The one line printed when no roles file exists. */
export function missingRolesLine(rolesFile) {
  return `jev route: no roles file at ${rolesFile} — create it with JSON like `
    + '[{"name":"DevOps-SRE","mission":"Gateway, worker, deploys, and the internal key channel"}] '
    + 'or set DSH_OFFLOAD_JEV_ROLES\n'
}

/** Resolve the roles file: flag, then env, then the project default. */
export function resolveRolesFile(flags, env, projectRoot) {
  if (typeof flags['roles-file'] === 'string' && flags['roles-file'] !== '') return flags['roles-file']
  if (typeof env.DSH_OFFLOAD_JEV_ROLES === 'string' && env.DSH_OFFLOAD_JEV_ROLES !== '') return env.DSH_OFFLOAD_JEV_ROLES
  return path.join(projectRoot ?? process.cwd(), ROLES_FILENAME)
}

/** Validate and normalise a parsed roles array. @returns `{name, mission}[]`. */
export function normalizeRoles(parsed) {
  if (!Array.isArray(parsed)) throw new Error('the roles file must be a JSON array')
  return parsed.map((role, index) => {
    if (role === null || typeof role !== 'object' || Array.isArray(role)) {
      throw new Error(`roles[${index}] must be an object with "name" and "mission"`)
    }
    const name = typeof role.name === 'string' ? role.name.trim() : ''
    const mission = typeof role.mission === 'string' ? role.mission.trim() : ''
    if (name === '' || mission === '') throw new Error(`roles[${index}] needs a non-empty "name" and "mission"`)
    return { name, mission }
  })
}

/**
 * Build the single request: one `fits_role_v2` noul per role (ids unique per
 * role) plus the two unvalidated nouls.
 * @returns `{state, questions}` ready for `callJev`.
 */
export function routeRequest(request, roles) {
  const questions = {}
  roles.forEach((role, index) => {
    questions[`role_${index}`] = {
      ...FITS_ROLE_V2,
      instructions: { role: { name: role.name, mission: role.mission }, question: FITS_ROLE_V2.instructions },
    }
  })
  questions.can_defer = CAN_DEFER
  questions.needs_background = NEEDS_BACKGROUND
  return { state: { request }, questions }
}

/** Rank roles by `fits_role_v2` probability, highest first; unknown values last. */
export function rankRoles(roles, answers) {
  return roles
    .map((role, index) => {
      const value = answers?.[`role_${index}`]?.noul
      return { name: role.name, index, noul: typeof value === 'number' ? value : null }
    })
    .sort((a, b) => {
      if (a.noul === null && b.noul === null) return a.index - b.index
      if (a.noul === null) return 1
      if (b.noul === null) return -1
      return b.noul - a.noul || a.index - b.index
    })
}

/** The suggested roles: every one at or above `FITS_SUGGEST`, else the single top. */
export function suggestedRoles(ranked) {
  const above = ranked.filter((role) => typeof role.noul === 'number' && role.noul >= FITS_SUGGEST)
  if (above.length > 0) return above
  return ranked.length > 0 && typeof ranked[0].noul === 'number' ? [ranked[0]] : []
}

/** The advice lines for the two unvalidated follow-up nouls. */
export function adviceLines(answers) {
  const lines = []
  const background = answers?.needs_background?.noul
  if (typeof background === 'number') {
    lines.push(background >= ADVICE_THRESHOLD
      ? `needs_background=${probability(background)} → several steps, files, or long builds: run it as a background job with \`dsh-offload start\``
      : `needs_background=${probability(background)} → a blocking \`deepseek_agent\` call may be enough`)
  }
  const defer = answers?.can_defer?.noul
  if (typeof defer === 'number') {
    lines.push(defer >= ADVICE_THRESHOLD
      ? `can_defer=${probability(defer)} → it can wait hours: add \`--defer-to-off-peak\``
      : `can_defer=${probability(defer)} → run it now; no \`--defer-to-off-peak\``)
  }
  return lines
}

function renderHuman(report, ctx) {
  const lines = []
  lines.push('jev route — a suggestion for the orchestrator, not a dispatch (extras can_defer/needs_background are UNVALIDATED)')
  lines.push(`prompt     ${report.promptFile}`)
  lines.push(`roles      ${report.ranked.length}`)
  report.ranked.forEach((role, index) => {
    lines.push(`${index + 1}. ${role.name.padEnd(24)} ${probability(role.noul)}`)
  })
  lines.push(report.suggested.length === 0
    ? 'suggested: (none — no role scored)'
    : `suggested: ${report.suggested.join(', ')}`)
  if (report.advice.length > 0) {
    lines.push('advice:')
    for (const line of report.advice) lines.push(`  - ${line}`)
  }
  lines.push(ROUTE_CAVEAT)
  ctx.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * `jev route --prompt-file F [--roles-file R] [--json]`.
 * @returns 0 on a suggestion (or a missing roles file), 1 on a read/API error.
 */
export async function runRoute(positional, flags, ctx) {
  const env = ctx.env
  if (!isEnabled(env)) {
    ctx.stdout.write(`${DISABLED_LINE}\n`)
    return 0
  }
  const promptFile = typeof flags['prompt-file'] === 'string'
    ? flags['prompt-file']
    : typeof flags.f === 'string' ? flags.f : positional[0] ?? null
  if (promptFile === null) {
    ctx.stderr.write('dsh-offload: jev route requires --prompt-file FILE\n')
    return 1
  }
  let prompt
  try {
    prompt = fs.readFileSync(promptFile, 'utf8').trim()
  } catch (error) {
    ctx.stderr.write(`dsh-offload: cannot read --prompt-file: ${error.message}\n`)
    return 1
  }

  const rolesFile = resolveRolesFile(flags, env, ctx.projectRoot)
  if (!fs.existsSync(rolesFile)) {
    ctx.stdout.write(missingRolesLine(rolesFile))
    return 0
  }
  let roles
  try {
    roles = normalizeRoles(JSON.parse(fs.readFileSync(rolesFile, 'utf8')))
  } catch (error) {
    ctx.stderr.write(`dsh-offload: cannot read roles file ${rolesFile}: ${error.message}\n`)
    return 1
  }
  if (roles.length === 0) {
    ctx.stdout.write(missingRolesLine(rolesFile))
    return 0
  }

  let answers
  let model
  try {
    const request = routeRequest(prompt, roles)
    const { json } = await callJev({ state: request.state, questions: request.questions, env })
    answers = json.answers ?? {}
    model = json.model ?? null
  } catch (error) {
    ctx.stderr.write(`dsh-offload: jev route failed: ${error.message}\n`)
    return 1
  }

  const ranked = rankRoles(roles, answers)
  const suggested = suggestedRoles(ranked).map((role) => role.name)
  const advice = adviceLines(answers)
  const report = {
    kind: 'jev-route',
    preScreen: true,
    unvalidatedExtras: ['can_defer', 'needs_background'],
    promptFile,
    rolesFile,
    model,
    ranked,
    suggested,
    answers,
    advice,
    caveat: ROUTE_CAVEAT,
  }
  if (flags.json === true) {
    ctx.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 0
  }
  renderHuman(report, ctx)
  return 0
}
