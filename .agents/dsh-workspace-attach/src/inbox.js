/**
 * Inbox I/O for the workspace-attach plugin.
 *
 * One request file per session the ACP automation plane created, one result
 * file per processed request, one heartbeat file proving the plugin is loaded:
 *
 *   <dir>/<sessionId>.request.json   { v, sessionId, path, title?, root?, jobId?, requestedBy?, requestedAt }
 *   <dir>/<sessionId>.result.json    { v, sessionId, ok, workspaceId?, path?, title?, created?, error?, at }
 *   <dir>/heartbeat.json             { v, plugin, pid, at, intervalMs, processed, failed }
 *
 * Writes are atomic (write a sibling temp file, then rename) because the
 * producer is a separate process that may read a result the moment it lands.
 * The session id is part of a file name, so it is validated against a strict
 * pattern rather than trusted.
 *
 * @module dsh-workspace-attach/inbox
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Protocol version carried by every request and result file. */
export const PROTOCOL_VERSION = 1

/** Plugin identity written into the heartbeat and every log line. */
export const PLUGIN_NAME = 'dsh-workspace-attach'

/** Heartbeat file name inside the inbox directory. */
export const HEARTBEAT_FILE = 'heartbeat.json'

/** Session ids safe to embed in a file name; anything else is refused. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * The DSH home this plugin writes beside, matching the bridge's own default.
 * @returns absolute DSH home path.
 */
export function dshHome() {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured.trim() !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Resolve the inbox directory: explicit config, then environment, then
 * `$DSH_HOME/workspace-attach`.
 * @param dir - `dir` from the plugin config, when set.
 * @returns absolute inbox directory path.
 */
export function resolveInboxDir(dir) {
  if (typeof dir === 'string' && dir.trim() !== '') return dir
  const configured = process.env.DSH_WORKSPACE_ATTACH_DIR
  if (configured !== undefined && configured.trim() !== '') return configured
  return join(dshHome(), 'workspace-attach')
}

/**
 * Validate a session id for use in a file name.
 * @param sessionId - untrusted session id.
 * @returns the session id when usable.
 */
export function requireSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`invalid sessionId ${JSON.stringify(sessionId)}: expected a plain id, not a path`)
  }
  return sessionId
}

/**
 * Path of one request file.
 * @param dir - inbox directory.
 * @param sessionId - session id.
 * @returns absolute request file path.
 */
export function requestFile(dir, sessionId) {
  return join(dir, `${requireSessionId(sessionId)}.request.json`)
}

/**
 * Path of one result file.
 * @param dir - inbox directory.
 * @param sessionId - session id.
 * @returns absolute result file path.
 */
export function resultFile(dir, sessionId) {
  return join(dir, `${requireSessionId(sessionId)}.result.json`)
}

/**
 * Write JSON atomically so a concurrent reader never sees a partial file.
 * @param file - absolute target path.
 * @param value - JSON-serializable value.
 * @returns resolution after the rename.
 */
export async function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value)}\n`, 'utf8')
  await rename(temp, file)
}

/**
 * Read one JSON file.
 * @param file - absolute path.
 * @returns the parsed value, or `undefined` when the file does not exist.
 */
export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * List pending request files in deterministic order.
 * @param dir - inbox directory.
 * @returns absolute paths of `*.request.json` files.
 */
export async function listRequests(dir) {
  const entries = await readdir(dir).catch((error) => {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
    throw error
  })
  return entries
    .filter(entry => entry.endsWith('.request.json'))
    .sort()
    .map(entry => join(dir, entry))
}

/**
 * Create the inbox directory when missing.
 * @param dir - inbox directory.
 * @returns resolution once the directory exists.
 */
export async function ensureInbox(dir) {
  await mkdir(dir, { recursive: true })
}

/**
 * Drop result files older than the retention window so the inbox stays small.
 * @param dir - inbox directory.
 * @param ttlMs - retention window in milliseconds.
 * @returns number of removed files.
 */
export async function pruneResults(dir, ttlMs) {
  const entries = await readdir(dir).catch(() => [])
  const now = Date.now()
  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith('.result.json')) continue
    const file = join(dir, entry)
    try {
      const info = await stat(file)
      if (now - info.mtimeMs <= ttlMs) continue
      await rm(file, { force: true })
      removed += 1
    } catch {
      // A result that vanished between readdir and stat is already gone.
    }
  }
  return removed
}

/**
 * Publish liveness so the producer can tell "GUI not running" apart from
 * "plugin not loaded" without waiting for a request to time out.
 * @param dir - inbox directory.
 * @param state - counters to publish with the timestamp.
 * @returns resolution after the write.
 */
export async function writeHeartbeat(dir, state) {
  await writeJsonAtomic(join(dir, HEARTBEAT_FILE), {
    v: PROTOCOL_VERSION,
    plugin: PLUGIN_NAME,
    pid: process.pid,
    at: new Date().toISOString(),
    ...state,
  })
}

/**
 * Report whether a request names a usable directory.
 * @param request - parsed request file.
 * @returns an error message, or `undefined` when the request is usable.
 */
export function validateRequest(request) {
  if (request === null || typeof request !== 'object') return 'request file is not a JSON object'
  if (request.v !== PROTOCOL_VERSION) return `unsupported request version ${JSON.stringify(request.v)}`
  try {
    requireSessionId(request.sessionId)
  } catch (error) {
    return error.message
  }
  if (typeof request.path !== 'string' || request.path === '') return 'request carries no path'
  if (!isAbsolute(request.path)) return `request path is not absolute: ${request.path}`
  return undefined
}
