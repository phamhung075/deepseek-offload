/**
 * The one source of truth for dsh-offload's command-line flags.
 *
 * Every command declares the flags it actually reads, split into those that are
 * booleans and those that take a value. `parseArgs` enforces that spec before
 * any command runs, so an unknown flag fails loudly instead of being stored and
 * ignored, and a boolean never swallows the positional that follows it.
 *
 * This mirrors the `flags[...]` / `flags.x` / `positiveFlag(flags...)` reads in
 * each `command*` function in `dsh-offload.mjs` (and the removed-flag list that
 * predates it). When a command starts reading a new flag, add it here: this
 * table is the only place the runner accepts flags from.
 */

/**
 * Flags removed with the retired judgment integration. Checked before anything
 * else, so an old command still passing one fails with the original message
 * rather than the generic unknown-flag error.
 */
export const REMOVED_FLAGS = Object.freeze([
  'review-repo',
  'review-base',
  'no-jev-review',
  'jev-mcp',
  'jev-lint',
  'jev-watch',
  'jev-exit',
])

/**
 * One entry per command: `name` is used in the unknown-flag message, `boolean`
 * flags are stored as `true` and never consume the next token, `value` flags
 * require a value (`--flag V` or `--flag=V`).
 *
 * `__run` is the internal worker mode the launcher spawns as
 * `dsh-offload.mjs __run <jobId>`; it takes no flags but is listed so the
 * parser knows it is a real command.
 */
export const COMMAND_FLAGS = Object.freeze({
  __run: Object.freeze({ name: '__run', boolean: [], value: [] }),
  start: Object.freeze({
    name: 'start',
    boolean: ['allow-git-write', 'read-only', 'detach', 'json', 'defer-to-off-peak'],
    value: ['prompt-file', 'f', 'cwd', 'mcp-config', 'label', 'permission', 'timeout-ms', 'wait-session-ms'],
  }),
  resume: Object.freeze({
    name: 'resume',
    boolean: ['read-only', 'allow-git-write', 'json'],
    value: ['session', 'cwd', 'label', 'timeout-ms', 'mcp-config'],
  }),
  status: Object.freeze({ name: 'status', boolean: ['json', 'log'], value: [] }),
  result: Object.freeze({ name: 'result', boolean: ['json'], value: [] }),
  guard: Object.freeze({ name: 'guard', boolean: ['json'], value: [] }),
  update: Object.freeze({ name: 'update', boolean: ['json'], value: [] }),
  cancel: Object.freeze({ name: 'cancel', boolean: ['json'], value: [] }),
  wait: Object.freeze({ name: 'wait', boolean: ['json'], value: ['timeout-ms'] }),
  list: Object.freeze({ name: 'list', boolean: ['all', 'json'], value: [] }),
  sessions: Object.freeze({ name: 'sessions', boolean: ['json'], value: ['cwd'] }),
  'mcp-servers': Object.freeze({ name: 'mcp-servers', boolean: ['json'], value: ['mcp-config'] }),
  'sync-workspace': Object.freeze({ name: 'sync-workspace', boolean: ['all', 'dry-run', 'json'], value: ['wait-ms'] }),
  doctor: Object.freeze({ name: 'doctor', boolean: ['json'], value: [] }),
  window: Object.freeze({ name: 'window', boolean: ['json'], value: ['tz'] }),
})

/**
 * The spec for one command, or null when the command is unknown. A null spec
 * makes `parseArgs` parse leniently so `main` still reports `unknown command`
 * (the pre-existing behaviour) rather than a flag error.
 */
export function specForCommand(command) {
  return Object.prototype.hasOwnProperty.call(COMMAND_FLAGS, command) ? COMMAND_FLAGS[command] : null
}

/** A flag-validation failure; the CLI entry point turns it into `fail(message)`. */
export class CliFlagError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CliFlagError'
  }
}

function throwFlagError(message) {
  throw new CliFlagError(message)
}

/**
 * Parse `argv` for one command.
 *
 * @param argv - command arguments, with the command name already stripped.
 * @param spec - the command's `COMMAND_FLAGS` entry, or null for lenient parsing.
 * @param fail - called with the user-facing message; defaults to throwing a
 *   `CliFlagError` so tests can drive the parser without a child process.
 * @returns `{ positional, flags }`, matching the runner's historical shape.
 */
export function parseArgs(argv, spec, fail = throwFlagError) {
  const strict = spec !== null && spec !== undefined
  const boolean = new Set(strict ? spec.boolean : [])
  const value = new Set(strict ? spec.value : [])
  const command = strict ? spec.name : null
  const positional = []
  const flags = {}

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    const isLong = token.startsWith('--')
    const isShort = !isLong && token.startsWith('-') && token !== '-'
    if (!isLong && !isShort) {
      positional.push(token)
      continue
    }

    const prefix = isLong ? '--' : '-'
    const body = token.slice(prefix.length)
    const eq = body.indexOf('=')
    const name = eq === -1 ? body : body.slice(0, eq)
    const inline = eq === -1 ? undefined : body.slice(eq + 1)

    // Removed flags keep their own message, and win over the unknown-flag check.
    if (REMOVED_FLAGS.includes(name)) {
      fail(`--${name} was removed and is no longer supported`)
      continue
    }

    if (strict && !boolean.has(name) && !value.has(name)) {
      fail(`unknown flag ${prefix}${name} for \`${command}\` (run \`dsh-offload help\`)`)
      continue
    }

    if (strict && boolean.has(name)) {
      if (inline !== undefined) fail(`flag ${prefix}${name} is a boolean and does not take a value`)
      else flags[name] = true
      continue
    }

    // A value flag (or, in lenient mode, any flag).
    if (inline !== undefined) {
      if (inline === '' && strict) fail(`flag ${prefix}${name} requires a value`)
      else flags[name] = inline
      continue
    }
    const next = argv[i + 1]
    const boundary = isLong ? '--' : '-'
    if (next !== undefined && !next.startsWith(boundary)) {
      flags[name] = next
      i++
      continue
    }
    if (strict) {
      fail(`flag ${prefix}${name} requires a value`)
      continue
    }
    flags[name] = true
  }

  return { positional, flags }
}
