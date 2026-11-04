/**
 * Where a running job worker advertises itself, and how the GUI hands it a
 * prompt with the browser's request id.
 *
 * The worker writes `$DSH_HOME/offload-workers/<jobId>.json`; a Host reads it
 * without knowing the per-project job store. A prompt that carries `rpcId` is
 * appended to the Session's control inbox instead of the bridge, so the running
 * Agent's durable user message echoes the browser identity and the GUI retires
 * its optimistic echo.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Directory under `$DSH_HOME` where running workers advertise themselves. */
export const WORKER_REGISTRY_DIR = 'offload-workers'

/** The control inbox suffix the fork `job-control` plugin polls. */
const CONTROL_SUFFIX = '.control.jsonl'

/**
 * Resolve the worker registry directory for one home.
 * @param home - explicit `$DSH_HOME`.
 * @returns the absolute registry path.
 */
export function workerRegistryDir(home = dshHome()) {
  return path.join(home, WORKER_REGISTRY_DIR)
}

/** Session log names, newest generation first when sorted numerically. */
const LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

/**
 * Resolve `$DSH_HOME`, defaulting to `~/.dsh`.
 * @param env - environment to read.
 * @returns the absolute home path.
 */
export function dshHome(env = process.env) {
  return env.DSH_HOME || path.join(env.HOME || os.homedir(), '.dsh')
}

/** Kernel start time of one pid, in clock ticks since boot; undefined off Linux. */
export function procStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const after = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ')
    // after[0] is field 3 (state), so field 22 (starttime) is after[19].
    return after[19]
  } catch {
    return undefined
  }
}

/**
 * Publish one worker's liveness beside the Host's other state.
 * @param options - job, session, socket, home, and optional overrides for tests.
 * @returns the written registry file path.
 */
export function publishWorkerLiveness({ jobId, sessionId, socketPath, home = dshHome(), pid = process.pid, startedAt = Date.now() }) {
  if (typeof sessionId !== 'string' || sessionId === '' || typeof socketPath !== 'string' || socketPath === '') return null
  const directory = workerRegistryDir(home)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const target = path.join(directory, `${jobId}.json`)
  const pidStart = procStartTime(pid)
  const body = JSON.stringify({
    v: 1,
    jobId,
    pid,
    ...(pidStart === undefined ? {} : { pidStart }),
    socketPath,
    sessionId,
    startedAt,
  })
  fs.writeFileSync(`${target}.tmp`, body)
  fs.renameSync(`${target}.tmp`, target)
  return target
}

/**
 * Remove a liveness file this worker published.
 * @param target - path returned by {@link publishWorkerLiveness}.
 */
export function unpublishWorkerLiveness(target) {
  if (typeof target !== 'string') return
  try {
    fs.unlinkSync(target)
  } catch {
    /* already removed, or a reboot cleaned the directory */
  }
}

/**
 * The current durable log of one Session across every project bucket.
 * @param sessionId - the Session to locate.
 * @param home - explicit `$DSH_HOME`.
 * @returns the artifact path, or null before the log exists.
 */
export function sessionLogPath(sessionId, home = dshHome()) {
  const root = path.join(home, 'sessions')
  let buckets
  try {
    buckets = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const dir = path.join(root, bucket.name, sessionId)
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    const newest = names
      .map(name => ({ name, match: LOG_NAME.exec(name) }))
      .filter(entry => entry.match !== null)
      .sort((a, b) => Number(b.match[1] ?? 0) - Number(a.match[1] ?? 0))[0]
    if (newest !== undefined) return path.join(dir, newest.name)
  }
  return null
}

/**
 * The control inbox that belongs to one Session's current log.
 * @param sessionId - the Session to locate.
 * @param home - explicit `$DSH_HOME`.
 * @returns the sibling control path, or null before the log exists.
 */
export function controlPathForSession(sessionId, home = dshHome()) {
  const log = sessionLogPath(sessionId, home)
  if (log === null) return null
  for (const suffix of ['.jsonl.zstd', '.jsonl']) {
    if (log.endsWith(suffix)) return `${log.slice(0, -suffix.length)}${CONTROL_SUFFIX}`
  }
  return null
}

/**
 * Append one steering line the fork `job-control` plugin will submit.
 * @param controlPath - path from {@link controlPathForSession}.
 * @param record - text plus the browser request id when the GUI sent it.
 */
export function appendControlLine(controlPath, { id, text, rpcId }) {
  fs.appendFileSync(controlPath, `${JSON.stringify({
    id: id ?? `steer-${Date.now()}`,
    text,
    ...(typeof rpcId === 'string' && rpcId !== '' ? { rpcId } : {}),
  })}\n`)
}
