/**
 * dsh-workspace-attach — a DSH Cordis function plugin for the `web` profile.
 *
 * The DeepSeek web GUI groups sessions by Workspace: the sidebar renders one
 * group per registered Workspace and drops every session the Workspace account
 * does not list into a trailing **Ungrouped** bucket. Membership is written by
 * exactly two host paths — the GUI's own `session.create` and the webhook plane
 * — so a session created by another process (here: the ACP automation plane
 * behind `.agents/mcp-deepseek/server.cjs`) is never accounted and stays
 * Ungrouped forever. The one-time cwd bootstrap that grouped older history
 * cannot help: it runs once, behind an `initialized` marker.
 *
 * This plugin closes that gap from inside the process that owns the account.
 * It watches an inbox directory for requests of the form
 * `{ sessionId, path }`, then drives `ctx.workspaceRegistry` to create the
 * Workspace for `path` (titled after the directory) and attach the session.
 * The registry must not be written by a second process: its durable state is
 * authoritative in memory, so an out-of-process writer is invisible to the GUI
 * and is overwritten by the GUI's next Workspace mutation.
 *
 * Protocol and lifecycle:
 * - Requests and results are single JSON files keyed by session id; the result
 *   file is written before the request file is removed, so a crash mid-adoption
 *   re-runs an idempotent operation instead of losing the request.
 * - `heartbeat.json` is republished every {@linkcode HEARTBEAT_MS}, letting the
 *   producer distinguish "GUI is not running" from "plugin is not loaded".
 * - Every failure is captured into the result file and logged; the scan loop
 *   never throws, because a broken request must not stop the GUI.
 *
 * Config (all optional, also readable from the environment):
 * - `enabled` (env `DSH_WORKSPACE_ATTACH=0` disables) — default `true`.
 * - `dir` (env `DSH_WORKSPACE_ATTACH_DIR`) — default `$DSH_HOME/workspace-attach`.
 * - `intervalMs` (env `DSH_WORKSPACE_ATTACH_INTERVAL_MS`) — default `1000`.
 * - `maxPerTick` — default `25`; requests beyond it wait for the next tick.
 * - `resultTtlMs` — default 24 h; older result files are pruned.
 *
 * @module dsh-workspace-attach
 */

import { rm } from 'node:fs/promises'
import { adoptSession } from './src/adopt.js'
import {
  PROTOCOL_VERSION,
  ensureInbox,
  listRequests,
  pruneResults,
  readJson,
  resultFile,
  resolveInboxDir,
  validateRequest,
  writeHeartbeat,
  writeJsonAtomic,
} from './src/inbox.js'

/** Plugin name registered with the Cordis loader. */
export const name = 'workspace-attach'

/** The plugin is inert without the Workspace registry, so it waits for it. */
export const inject = ['workspaceRegistry']

/** Heartbeat cadence: stable enough for a producer's liveness probe, cheap enough to ignore. */
const HEARTBEAT_MS = 5000

/**
 * Mount the inbox scan loop.
 * @param ctx - plugin context carrying `workspaceRegistry` and `logger`.
 * @param config - optional plugin config (see the module docblock).
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config)
  const logger = ctx.logger
  const registry = ctx.workspaceRegistry
  const state = { processed: 0, failed: 0, lastHeartbeatAt: 0, scanning: false }

  if (!options.enabled) {
    logger.info(`[${name}] disabled by config or DSH_WORKSPACE_ATTACH=0 — ACP sessions stay Ungrouped`)
    return
  }
  if (registry === undefined || typeof registry.resolveByPath !== 'function') {
    logger.warn(`[${name}] workspaceRegistry is unavailable — nothing can be adopted`)
    return
  }

  logger.info(`[${name}] watching ${options.dir} every ${options.intervalMs}ms`)

  const tick = () => {
    void runTick(ctx, registry, options, state)
  }
  schedule(ctx, tick, options.intervalMs)
  tick()
}

/**
 * Read the plugin config with environment fallbacks.
 * @param config - raw loader config.
 * @returns normalized options.
 */
function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const enabled = raw.enabled !== undefined
    ? raw.enabled !== false
    : process.env.DSH_WORKSPACE_ATTACH !== '0'
  return {
    enabled,
    dir: resolveInboxDir(raw.dir),
    intervalMs: positiveInt(raw.intervalMs ?? process.env.DSH_WORKSPACE_ATTACH_INTERVAL_MS, 1000),
    maxPerTick: positiveInt(raw.maxPerTick, 25),
    resultTtlMs: positiveInt(raw.resultTtlMs, 24 * 60 * 60 * 1000),
  }
}

/**
 * @param value - candidate number or numeric string.
 * @param fallback - value used when the candidate is not a positive integer.
 * @returns a positive integer.
 */
function positiveInt(value, fallback) {
  const parsed = typeof value === 'string' ? Number(value) : value
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Repeat `fn` on a lifecycle-owned timer.
 *
 * The timer service is read through `ctx.get` rather than declared in `inject`:
 * a profile without it must still get a working loop, and an inject declaration
 * would leave this plugin permanently pending instead.
 * @param ctx - plugin context.
 * @param fn - callback.
 * @param ms - interval in milliseconds.
 * @returns a disposer for the timer.
 */
function schedule(ctx, fn, ms) {
  const timer = ctx.get('timer')
  if (timer !== undefined && typeof timer.interval === 'function') return timer.interval(fn, ms)
  // No timer service: own the interval with this fiber so unloading stops it.
  const handle = setInterval(fn, ms)
  ctx.effect(() => () => clearInterval(handle))
  return () => clearInterval(handle)
}

/**
 * One scan: adopt every pending request, prune old results, publish liveness.
 * @param ctx - plugin context.
 * @param registry - `ctx.workspaceRegistry`.
 * @param options - normalized options.
 * @param state - counters shared across ticks.
 * @returns resolution when the scan settles; never rejects.
 */
async function runTick(ctx, registry, options, state) {
  if (state.scanning) return
  state.scanning = true
  const logger = ctx.logger
  let adopted = 0
  try {
    await ensureInbox(options.dir)
    const pending = await listRequests(options.dir)
    for (const file of pending.slice(0, options.maxPerTick)) {
      if (await processRequest(ctx, registry, options.dir, file, state)) adopted += 1
    }
    if (pending.length > options.maxPerTick) {
      logger.info(`[${name}] ${pending.length - options.maxPerTick} request(s) waiting for the next scan`)
    }
    const pruned = await pruneResults(options.dir, options.resultTtlMs)
    if (pruned > 0) logger.debug(`[${name}] pruned ${pruned} stale result file(s)`)
    if (Date.now() - state.lastHeartbeatAt >= HEARTBEAT_MS) {
      state.lastHeartbeatAt = Date.now()
      await writeHeartbeat(options.dir, {
        intervalMs: options.intervalMs,
        processed: state.processed,
        failed: state.failed,
      })
    }
    if (adopted > 0) {
      logger.info(`[${name}] adopted ${adopted} session(s); ${state.failed} failure(s) so far`)
    }
  } catch (error) {
    // A failing scan must not break the GUI; the next tick retries.
    logger.warn(`[${name}] scan failed — ${message(error)}`)
  } finally {
    state.scanning = false
  }
}

/**
 * Adopt one request file and record the outcome beside it.
 * @param ctx - plugin context.
 * @param registry - `ctx.workspaceRegistry`.
 * @param dir - inbox directory holding the request and its result.
 * @param file - absolute request file path.
 * @param state - counters shared across ticks.
 * @returns whether a session ended up accounted.
 */
async function processRequest(ctx, registry, dir, file, state) {
  const logger = ctx.logger
  let request
  try {
    request = await readJson(file)
  } catch (error) {
    logger.warn(`[${name}] ${file} is not readable JSON — left in place: ${message(error)}`)
    return false
  }
  if (request === undefined) return false

  const invalid = validateRequest(request)
  if (invalid !== undefined) {
    logger.warn(`[${name}] ${file} is not a usable request — left in place: ${invalid}`)
    return false
  }

  const outcome = await adoptSession(registry, request)
  state.processed += 1
  if (outcome.ok) {
    const verb = outcome.already === true ? 'already accounted' : outcome.created === true ? 'created' : 'joined'
    logger.info(
      `[${name}] session ${outcome.sessionId} ${verb} workspace "${outcome.title}" (${outcome.path})`,
    )
  } else {
    state.failed += 1
    logger.warn(
      `[${name}] session ${outcome.sessionId} could not join "${request.path}"`
      + `${outcome.rolledBack === true ? ' (empty workspace removed)' : ''} — ${outcome.error}`,
    )
  }

  try {
    await writeJsonAtomic(resultFile(dir, outcome.sessionId), {
      v: PROTOCOL_VERSION,
      at: new Date().toISOString(),
      ...outcome,
    })
  } catch (error) {
    logger.warn(`[${name}] could not publish the result for ${outcome.sessionId} — ${message(error)}`)
  }
  await rm(file, { force: true })
  return outcome.ok
}

/**
 * @param error - thrown value.
 * @returns its message.
 */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
