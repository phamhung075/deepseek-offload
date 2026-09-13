#!/usr/bin/env node
/**
 * dsh-offload — fire-and-forget background delegation to a DeepSeek Harness agent.
 *
 * This is a thin MCP *client* for the existing bridge at
 * `bridge/server.cjs`. It does not reimplement ACP: it speaks MCP
 * over stdio to that bridge, exactly like an MCP-enabled editor would, so every
 * job it starts is a real DSH session persisted to the shared session store
 * (`DSH_HOME`, default `~/.dsh`) that the DeepSeek web GUI lists — cold: the
 * GUI cannot show a session another process is running.
 *
 * The bridge's `deepseek_agent` tool blocks until the task finishes. This script
 * adds the missing background half: `start` returns a job id immediately,
 * a detached worker process owns the session, and `status` / `result` / `wait`
 * read its job file under `scratch/dsh-offload/`.
 *
 * Zero dependencies. Node >= 18.
 *
 * Usage:
 *   node dsh-offload.mjs doctor
 *   node dsh-offload.mjs window [--tz IANA_NAME]
 *   node dsh-offload.mjs start "<self-contained prompt>" [--cwd DIR] [--label NAME] [--defer-to-off-peak]
 *   node dsh-offload.mjs status <jobId>
 *   node dsh-offload.mjs result <jobId>
 *   node dsh-offload.mjs wait   <jobId> [--timeout-ms N]
 *   node dsh-offload.mjs update <jobId> "<new information>"
 *   node dsh-offload.mjs cancel <jobId>
 *   node dsh-offload.mjs list   [--all]
 *   node dsh-offload.mjs sessions [--cwd DIR]
 *   node dsh-offload.mjs sync-workspace [--all] [--dry-run]
 *
 * The GUI groups sessions by Workspace, and only the GUI process may write that
 * account, so every job also queues an adoption request that the
 * `dsh-workspace-attach` web-profile plugin turns into
 * create-Workspace + attachSession. `sync-workspace` replays that request for
 * sessions created before the plugin was installed.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Paths and defaults
// ---------------------------------------------------------------------------
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
// <repo>/.agents/skills/deepseek-offload/scripts -> <repo>/.agents
const AGENTS_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..')
const BRIDGE_SERVER = path.join(AGENTS_ROOT, 'mcp-deepseek', 'server.cjs')
// The project the jobs belong to: the caller's directory. Job records and result
// files live under it, so a project that vendors this repository keeps its own
// job history.
const PROJECT_ROOT = process.env.DSH_BRIDGE_PROJECT_ROOT || process.cwd()
const JOB_ROOT = process.env.DSH_OFFLOAD_JOB_DIR || path.join(PROJECT_ROOT, 'scratch', 'dsh-offload')
const JOBS_DIR = path.join(JOB_ROOT, 'jobs')
const DEFAULT_CWD = process.env.DEEPSEEK_MCP_DEFAULT_CWD || PROJECT_ROOT
const DEFAULT_PERMISSION = process.env.DEEPSEEK_MCP_PERMISSION || 'allow'
const DEFAULT_TIMEOUT_MS = Number(process.env.DEEPSEEK_MCP_TIMEOUT_MS || 15 * 60 * 1000)
const GUI_URL = process.env.DSH_GUI_URL || 'http://127.0.0.1:3080'

/** Sibling live tailer: the only way to follow a run the GUI cannot stream. */
const SESSION_TAIL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-tail.mjs')

/**
 * The command a caller runs to follow one job's session log. A project that
 * links the tailer into its own `.agents/` tree gets the short relative path.
 * @param jobId - job whose session log the caller wants to follow.
 * @returns the shell command to run.
 */
function followCommand(jobId) {
  const linked = path.join(process.cwd(), '.agents', 'skills', 'deepseek-offload', 'scripts', 'session-tail.mjs')
  const shown = fs.existsSync(linked) ? path.relative(process.cwd(), linked) : SESSION_TAIL
  return `node ${shown} ${jobId} --watch`
}
const SESSION_DISCOVERY_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 3_000

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function fail(message) {
  process.stderr.write(`dsh-offload: ${message}\n`)
  process.exit(1)
}

function isAbsolutePath(value) {
  return typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))
}

function ensureDirs() {
  fs.mkdirSync(JOBS_DIR, { recursive: true })
}

function jobFile(jobId) {
  return path.join(JOBS_DIR, `${jobId}.json`)
}

function resultFile(jobId) {
  return path.join(JOBS_DIR, `${jobId}.result.md`)
}

function workerLogFile(jobId) {
  return path.join(JOBS_DIR, `${jobId}.worker.log`)
}

function jobSocketFile(jobId) {
  return path.join(JOBS_DIR, `${jobId}.sock`)
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

function readJob(jobId) {
  const file = jobFile(jobId)
  if (!fs.existsSync(file)) fail(`unknown job id: ${jobId} (see \`list\`)`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Report a job whose worker process died without writing a final state.
 * @param job - job record read from disk.
 * @returns the job record, marked failed when its worker is gone.
 */
function reconcileJob(job) {
  if (!isActiveState(job.state)) return job
  if (typeof job.pid !== 'number') return job
  let alive = true
  try {
    process.kill(job.pid, 0)
  } catch (error) {
    alive = error.code === 'EPERM'
  }
  if (alive) return job
  return updateJob(job.jobId, {
    state: 'error',
    error: `worker process ${job.pid} is gone; see ${path.basename(workerLogFile(job.jobId))}`,
    finishedAt: Date.now(),
  })
}

function updateJob(jobId, patch) {
  const next = { ...readJob(jobId), ...patch }
  writeJsonAtomic(jobFile(jobId), next)
  return next
}

function listJobIds() {
  if (!fs.existsSync(JOBS_DIR)) return []
  return fs
    .readdirSync(JOBS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort()
    .reverse()
}

function newJobId() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const rand = Math.random().toString(16).slice(2, 6)
  return `job-${stamp}-${rand}`
}

function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a'
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

// A job in any of these states is still doing something — not yet a final
// result. Kept as one set so every command agrees on what "not finished" means.
const ACTIVE_STATES = new Set(['scheduled', 'starting', 'running'])
function isActiveState(state) {
  return ACTIVE_STATES.has(state)
}

// ---------------------------------------------------------------------------
// DeepSeek peak/off-peak window math
// ---------------------------------------------------------------------------
// Peak: 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday; everything else
// (including all of Saturday/Sunday) is off-peak at half price.
// Source: https://api-docs.deepseek.com/quick_start/pricing
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 24 * MS_PER_HOUR

function utcMidnight(ms) {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** The day's peak windows as `[startMs, endMs)` pairs; `[]` on a weekend. */
function dayPeakWindows(dayMidnightMs, dayOfWeek) {
  if (dayOfWeek === 0 || dayOfWeek === 6) return []
  return [
    [dayMidnightMs + 1 * MS_PER_HOUR, dayMidnightMs + 4 * MS_PER_HOUR],
    [dayMidnightMs + 6 * MS_PER_HOUR, dayMidnightMs + 10 * MS_PER_HOUR],
  ]
}

function isPeakAt(ms) {
  const midnight = utcMidnight(ms)
  const dow = new Date(midnight).getUTCDay()
  for (const [start, end] of dayPeakWindows(midnight, dow)) {
    if (ms >= start && ms < end) return true
  }
  return false
}

/** First instant at or after `ms` where `isPeakAt` equals `wantPeakAfter`, searching up to 9 days out. */
function nextBoundaryAfter(ms, wantPeakAfter) {
  const startMidnight = utcMidnight(ms)
  for (let dayOffset = 0; dayOffset < 9; dayOffset++) {
    const dayStart = startMidnight + dayOffset * MS_PER_DAY
    const dow = new Date(dayStart).getUTCDay()
    const candidates = dayPeakWindows(dayStart, dow).flat().sort((a, b) => a - b)
    for (const c of candidates) {
      if (c <= ms) continue
      if (isPeakAt(c) === wantPeakAfter) return c
    }
  }
  throw new Error(`no ${wantPeakAfter ? 'peak' : 'off-peak'} boundary found within 9 days of ${new Date(ms).toISOString()}`)
}

function nextPeakStart(ms) {
  return isPeakAt(ms) ? ms : nextBoundaryAfter(ms, true)
}

function nextOffPeakStart(ms) {
  return isPeakAt(ms) ? nextBoundaryAfter(ms, false) : ms
}

/** `ms` rendered in `tz` (IANA name) as `YYYY-MM-DD HH:MM:SS`. */
function formatLocal(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(ms))
  const get = (type) => parts.find((p) => p.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

function print(value, asJson) {
  if (asJson) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=')
      if (inline !== undefined) {
        flags[name] = inline
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        flags[name] = argv[i + 1]
        i++
      } else {
        flags[name] = true
      }
    } else {
      positional.push(token)
    }
  }
  return { positional, flags }
}

// ---------------------------------------------------------------------------
// MCP client over the existing bridge
// ---------------------------------------------------------------------------
class Bridge {
  constructor({ permission = DEFAULT_PERMISSION, timeoutMs = DEFAULT_TIMEOUT_MS, onProgress = null } = {}) {
    this.pending = new Map()
    this.nextId = 1
    this.buffer = ''
    this.exited = false
    this.exitError = null
    this.onProgress = onProgress

    this.child = spawn(process.execPath, [BRIDGE_SERVER], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DEEPSEEK_MCP_PERMISSION: permission,
        DEEPSEEK_MCP_TIMEOUT_MS: String(timeoutMs),
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.#onData(chunk))
    this.child.on('error', (error) => this.#failAll(error))
    this.child.on('exit', (code) => {
      this.exited = true
      if (code !== 0) this.exitError = new Error(`deepseek bridge exited with code ${code}`)
      this.#failAll(this.exitError || new Error('deepseek bridge exited'))
    })
  }

  #failAll(error) {
    this.exited = true
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  #onData(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this.#onMessage(message)
    }
  }

  #onMessage(message) {
    if (message === null || typeof message !== 'object') return
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) {
        // The bridge sends no server->client requests today; never leave one hanging.
        this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
      } else if (this.onProgress && message.method === 'notifications/progress') {
        this.onProgress(message.params || {})
      }
      return
    }
    const entry = this.pending.get(String(message.id))
    if (entry === undefined) return
    this.pending.delete(String(message.id))
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message || 'MCP error'))
    else entry.resolve(message.result)
  }

  #write(message) {
    if (this.exited) return
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      /* the exit handler surfaces the failure to every pending request */
    }
  }

  request(method, params, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(this.exitError || new Error('deepseek bridge is not running'))
        return
      }
      const id = String(this.nextId++)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bridge request timed out after ${timeoutMs}ms: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params })
  }

  async initialize() {
    await this.request('initialize', { protocolVersion: '2024-11-05', clientCapabilities: {} }, 60_000)
    this.notify('notifications/initialized', {})
  }

  /** Call one bridge tool and return its text payload. */
  async callTool(name, args, { timeoutMs = 60_000, progressToken = null } = {}) {
    const params = { name, arguments: args }
    if (progressToken !== null) params._meta = { progressToken }
    const result = await this.request('tools/call', params, timeoutMs)
    const content = result && Array.isArray(result.content) ? result.content : []
    const text = content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
    return { text, isError: Boolean(result && result.isError), raw: result }
  }

  /**
   * Call one bridge tool, raising the bridge's own diagnostic on failure.
   * @param name - bridge tool name.
   * @param args - tool arguments.
   * @param options - request timeout and optional progress token.
   * @returns the tool's text payload and raw result.
   */
  async callToolOrThrow(name, args, options) {
    const { text, isError, raw } = await this.callTool(name, args, options)
    if (isError) throw new Error(text.replace(/^Error:\s*/, ''))
    return { text, raw }
  }

  dispose() {
    return new Promise((resolve) => {
      if (this.exited) {
        resolve()
        return
      }
      let settled = false
      const finish = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      try {
        this.child.stdin.end()
      } catch {
        /* stdin may already be closed */
      }
      const hard = setTimeout(() => {
        try {
          this.child.kill('SIGTERM')
        } catch {
          /* process already gone */
        }
        setTimeout(() => {
          try {
            this.child.kill('SIGKILL')
          } catch {
            /* process already gone */
          }
          finish()
        }, 3_000)
      }, 6_000)
      this.child.once('exit', () => {
        clearTimeout(hard)
        finish()
      })
      this.child.once('error', () => {
        clearTimeout(hard)
        finish()
      })
    })
  }
}

async function withBridge(options, fn) {
  const bridge = new Bridge(options)
  try {
    await bridge.initialize()
    return await fn(bridge)
  } finally {
    await bridge.dispose()
  }
}

// ---------------------------------------------------------------------------
// Bridge result parsing
// ---------------------------------------------------------------------------
const SUMMARY_PATTERN = /stopReason=([^,]+),\s*(\d+)ms,\s*session=([^\s)]+)/
// The bridge reports workspace grouping on its own header line: a fact about the
// GUI's sidebar rather than about the answer, so it never reaches the body.
const WORKSPACE_PATTERN = /^Workspace:\s*(.+)$/m

function parseAgentResult(text) {
  const separator = text.indexOf('\n\n')
  const header = separator === -1 ? text : text.slice(0, separator)
  const body = separator === -1 ? '' : text.slice(separator + 2)
  const workspace = WORKSPACE_PATTERN.exec(text)
  const match = SUMMARY_PATTERN.exec(header)
  if (match === null) {
    return {
      sessionId: null, stopReason: null, elapsedMs: null, body: text,
      workspace: workspace === null ? null : workspace[1].trim(),
    }
  }
  return {
    sessionId: match[3],
    stopReason: match[1],
    elapsedMs: Number(match[2]),
    body,
    workspace: workspace === null ? null : workspace[1].trim(),
  }
}

/**
 * Session ids as the bridge prints them: the store holds both bare uuids and
 * legacy `session-<uuid>` directory names, so never assume one id form.
 */
const SESSION_LINE_PATTERN = /^-\s+(\S+)\s+cwd=(\S+)/

function parseSessionIds(text) {
  const ids = []
  for (const line of text.split('\n')) {
    const match = SESSION_LINE_PATTERN.exec(line.trim())
    if (match !== null) ids.push(match[1])
  }
  return ids
}

/** Session rows with their recorded directory, for directory-scoped grouping work. */
function parseSessionRows(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const match = SESSION_LINE_PATTERN.exec(line.trim())
    if (match !== null) rows.push({ sessionId: match[1], cwd: match[2] })
  }
  return rows
}

async function fetchSessions(bridge, cwd) {
  const args = cwd === undefined ? {} : { cwd }
  // The bridge prints either "No DeepSeek sessions found." or "<n> session(s):\n- <id>  cwd=..."
  const { text } = await bridge.callToolOrThrow('deepseek_list_sessions', args, { timeoutMs: 90_000 })
  return parseSessionIds(text)
}

function claimedSessionIds(exceptJobId) {
  const claimed = new Set()
  for (const jobId of listJobIds()) {
    if (jobId === exceptJobId) continue
    try {
      const job = readJob(jobId)
      if (job.sessionId) claimed.add(job.sessionId)
    } catch {
      /* a job file being rewritten is not a reason to abort discovery */
    }
  }
  return claimed
}

// ---------------------------------------------------------------------------
// Workspace grouping (the same file inbox the bridge writes)
// ---------------------------------------------------------------------------
// The web GUI groups sessions by Workspace and only the GUI process may write
// that account, so grouping is requested through an inbox drained by the
// `dsh-workspace-attach` plugin. `sync-workspace` uses the same
// protocol as the bridge to adopt sessions that were created before the plugin
// existed. See `plugin/dsh-workspace-attach/README.md`.
const DSH_HOME = process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh')
const WORKSPACE_ATTACH_DIR = process.env.DEEPSEEK_WORKSPACE_ATTACH_DIR
  || process.env.DSH_WORKSPACE_ATTACH_DIR
  || path.join(DSH_HOME, 'workspace-attach')
/** A heartbeat older than this means the GUI or its plugin stopped. */
const WORKSPACE_HEARTBEAT_MS = 30_000

/** Session ids the GUI currently accounts to some Workspace (read-only). */
function accountedSessionIds() {
  const store = path.join(DSH_HOME, 'storages', 'workspace.json')
  const accounted = new Set()
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(store, 'utf8'))
  } catch {
    return accounted
  }
  for (const workspace of Object.values(parsed?.tables?.workspaces ?? {})) {
    for (const id of workspace?.sessionIds ?? []) accounted.add(id)
  }
  return accounted
}

/** The GUI plugin's heartbeat, when it is recent enough to trust. */
function workspaceHeartbeat() {
  try {
    const beat = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ATTACH_DIR, 'heartbeat.json'), 'utf8'))
    const age = Date.now() - Date.parse(beat.at)
    return { ...beat, ageMs: age, fresh: Number.isFinite(age) && age <= WORKSPACE_HEARTBEAT_MS }
  } catch {
    return null
  }
}

/** Whether the web GUI itself answers on its port (any HTTP status means it is up). */
async function guiReachable() {
  try {
    await fetch(GUI_URL, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    // Only a transport failure (refused, timed out) reaches here.
    return false
  }
}

/** Queue one adoption request the plugin will drain. */
function queueWorkspaceRequest(sessionId, cwd) {
  fs.mkdirSync(WORKSPACE_ATTACH_DIR, { recursive: true })
  // A result left over from an earlier attempt must not be mistaken for this one.
  fs.rmSync(workspaceAttachResultFile(sessionId), { force: true })
  const file = path.join(WORKSPACE_ATTACH_DIR, `${sessionId}.request.json`)
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify({
    v: 1,
    sessionId,
    path: cwd,
    requestedAt: new Date().toISOString(),
    requestedBy: 'dsh-offload',
  })}\n`)
  fs.renameSync(temp, file)
  return file
}

function workspaceAttachResultFile(sessionId) {
  return path.join(WORKSPACE_ATTACH_DIR, `${sessionId}.result.json`)
}

/** Wait until every requested session has an answer, or the deadline passes. */
async function awaitWorkspaceResults(sessionIds, timeoutMs) {
  const answers = new Map()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const sessionId of sessionIds) {
      if (answers.has(sessionId)) continue
      try {
        answers.set(sessionId, JSON.parse(fs.readFileSync(workspaceAttachResultFile(sessionId), 'utf8')))
      } catch {
        /* no answer yet */
      }
    }
    if (answers.size === sessionIds.length || Date.now() >= deadline) return answers
    await new Promise((resolve) => { setTimeout(resolve, 150) })
  }
}

// ---------------------------------------------------------------------------
// Live steering channel (worker side + CLI client)
// ---------------------------------------------------------------------------
/**
 * Open the worker's Unix-domain-socket channel that `update` connects to.
 * The worker owns the only live Bridge for its job, so a course correction has
 * to arrive here — the job file alone cannot reach the running session.
 * @param jobId - the job whose worker is listening.
 * @param bridge - the worker's initialized bridge holding the session.
 * @returns the listening net.Server once it is ready.
 */
function startUpdateSocket(jobId, bridge) {
  return new Promise((resolve, reject) => {
    const sockPath = jobSocketFile(jobId)
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8')
      let buffer = ''
      let handled = false

      const reply = (payload) => {
        if (handled) return
        handled = true
        try {
          socket.end(`${JSON.stringify(payload)}\n`)
        } catch {
          socket.destroy()
        }
      }

      socket.on('error', () => socket.destroy())
      socket.on('data', (chunk) => {
        if (handled) return
        buffer += chunk
        const index = buffer.indexOf('\n')
        if (index === -1) return
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)

        let payload
        try {
          payload = JSON.parse(line)
        } catch {
          reply({ ok: false, error: 'invalid request: expected one line of JSON like {"message":"..."}' })
          return
        }
        const message = payload && typeof payload.message === 'string' ? payload.message.trim() : ''
        const cancelOnly = payload && payload.cancel === true
        if (message === '' && !cancelOnly) {
          reply({ ok: false, error: 'request requires a non-empty "message" string, or {"cancel":true} to stop without redirecting' })
          return
        }

        let current
        try {
          current = readJob(jobId)
        } catch (error) {
          reply({ ok: false, error: error && error.message ? error.message : String(error) })
          return
        }
        // Read the session id fresh: the discovery loop writes it asynchronously.
        if (!current.sessionId) {
          reply({ ok: false, error: 'session not discovered yet — retry in a few seconds' })
          return
        }

        // Omitting message from the forwarded call (not just sending '') is what tells
        // the bridge this is a bare cancel — see deepseek_update_session in server.cjs.
        const toolArgs = message !== ''
          ? { sessionId: current.sessionId, message }
          : { sessionId: current.sessionId }

        bridge
          .callTool('deepseek_update_session', toolArgs, { timeoutMs: 30_000 })
          .then((result) => {
            if (result.isError) {
              reply({ ok: false, error: result.text })
              return
            }
            if (message !== '') updateJob(jobId, { updateCount: (current.updateCount || 0) + 1, lastUpdateAt: Date.now() })
            reply({ ok: true })
          })
          .catch((error) => reply({ ok: false, error: error && error.message ? error.message : String(error) }))
      })
    })

    server.on('error', reject)
    // A socket file left by a crashed worker of the same id must not block listen.
    try {
      fs.unlinkSync(sockPath)
    } catch {
      /* no stale socket */
    }
    server.listen(sockPath, () => resolve(server))
  })
}

/**
 * Send one JSON line to a worker's update socket and read one JSON line back.
 * @param sockPath - the worker's socket path.
 * @param payload - request object, e.g. `{ message }`.
 * @param timeoutMs - how long to wait for the worker's answer.
 * @returns the parsed response object.
 */
function sendSocketRequest(sockPath, payload, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath)
    let buffer = ''
    let settled = false

    const finish = (error, response) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(response)
    }
    const timer = setTimeout(() => {
      finish(new Error(`timed out after ${timeoutMs}ms waiting for the job worker to answer`))
    }, timeoutMs)

    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      let response
      try {
        response = JSON.parse(buffer.slice(0, index))
      } catch (error) {
        finish(new Error(`job worker sent an unreadable response: ${error.message}`))
        return
      }
      finish(null, response)
    })
    socket.on('end', () => finish(new Error('job worker closed the connection without answering')))
    socket.on('error', (error) => {
      if (error.code === 'ENOENT') {
        finish(new Error(`no update socket at ${sockPath} — the job worker is not running (or predates \`update\`)`))
      } else if (error.code === 'ECONNREFUSED') {
        finish(new Error(`stale update socket at ${sockPath} — the job worker is gone`))
      } else {
        finish(error)
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Worker: owns one background job
// ---------------------------------------------------------------------------
async function runWorker(jobId) {
  const job = readJob(jobId)
  const startedAt = job.startedAt
  let bridge
  let updateServer
  try {
    // A --defer-to-off-peak start: sleep here (worker already spawned and cancel-able
    // via forceKillWorkerTree, since no bridge/socket exists yet to accept a graceful
    // one) until the off-peak window begins, then fall through to the normal run.
    if (typeof job.deferredUntil === 'number' && job.deferredUntil > Date.now()) {
      updateJob(jobId, { state: 'scheduled' })
      while (Date.now() < job.deferredUntil) {
        const remaining = job.deferredUntil - Date.now()
        await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 30_000)))
      }
      updateJob(jobId, { state: 'starting', wokeAt: Date.now() })
    }

    bridge = new Bridge({
      permission: job.permission,
      timeoutMs: job.timeoutMs,
      onProgress: (params) => {
        try {
          updateJob(jobId, { progressChars: params.progress ?? 0, lastProgressAt: Date.now() })
        } catch {
          /* status updates are best-effort */
        }
      },
    })
    await bridge.initialize()
    updateServer = await startUpdateSocket(jobId, bridge)
    updateJob(jobId, { state: 'running', workerStartedAt: Date.now() })

    const before = new Set(await fetchSessions(bridge, job.cwd).catch(() => []))
    updateJob(jobId, { knownSessions: before.size })

    const agentCall = bridge
      .callTool(
        'deepseek_agent',
        job.mcpConfig === null || job.mcpConfig === undefined
          ? { prompt: job.prompt, cwd: job.cwd }
          : { prompt: job.prompt, cwd: job.cwd, mcpConfig: job.mcpConfig },
        { timeoutMs: job.timeoutMs + 120_000, progressToken: 'dsh-offload' },
      )
      // An MCP-level failure arrives as a successful result carrying isError:
      // without this check a dead job would be recorded as a finished one, with
      // the error text handed back as if it were an answer.
      .then((value) => (value.isError
        ? { error: new Error(value.text.replace(/^Error:\s*/, '')) }
        : { value }))
      .catch((error) => ({ error }))

    // Discover the new session id while the agent works, so the caller can be
    // sent to the web GUI before the job finishes.
    const discoveryDeadline = Date.now() + SESSION_DISCOVERY_TIMEOUT_MS
    let discovered = null
    while (Date.now() < discoveryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      if (discovered === null) {
        try {
          const claimed = claimedSessionIds(jobId)
          const fresh = (await fetchSessions(bridge, job.cwd)).filter((id) => !before.has(id) && !claimed.has(id))
          if (fresh.length > 0) {
            discovered = fresh[0]
            updateJob(jobId, { sessionId: discovered, sessionDiscoveredAt: Date.now() })
          }
        } catch {
          /* keep polling: the listing may race session materialization */
        }
      }
      const settled = await Promise.race([agentCall, Promise.resolve(SYMBOL_PENDING)])
      if (settled !== SYMBOL_PENDING) break
    }

    const outcome = await agentCall
    const finishedAt = Date.now()
    if (outcome.error) {
      const message = outcome.error.message || String(outcome.error)
      const sessionId = discovered ?? parseAgentResult(message).sessionId
      updateJob(jobId, {
        state: 'error',
        error: message,
        sessionId,
        workspace: parseAgentResult(message).workspace,
        finishedAt,
        elapsedMs: finishedAt - startedAt,
      })
      fs.writeFileSync(resultFile(jobId), `${message}\n`)
      return 1
    }

    const parsed = parseAgentResult(outcome.value.text)
    fs.writeFileSync(resultFile(jobId), `${parsed.body}\n`)
    updateJob(jobId, {
      state: parsed.stopReason === 'cancelled' ? 'cancelled' : 'done',
      sessionId: discovered ?? parsed.sessionId,
      stopReason: parsed.stopReason,
      bridgeElapsedMs: parsed.elapsedMs,
      resultChars: parsed.body.length,
      workspace: parsed.workspace,
      finishedAt,
      elapsedMs: finishedAt - startedAt,
      resultFile: path.relative(PROJECT_ROOT, resultFile(jobId)),
    })
    return 0
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    try {
      updateJob(jobId, { state: 'error', error: message, finishedAt: Date.now() })
    } catch {
      /* the job file may be unreadable if it was deleted mid-run */
    }
    return 1
  } finally {
    if (updateServer !== undefined) {
      updateServer.close()
      updateServer.unref()
    }
    if (bridge !== undefined) await bridge.dispose()
    try {
      fs.unlinkSync(jobSocketFile(jobId))
    } catch {
      /* the socket file is already gone */
    }
  }
}

const SYMBOL_PENDING = Symbol('pending')

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function describeJob(job, { full = false } = {}) {
  const lines = [
    `job       ${job.jobId}${job.label ? `  (${job.label})` : ''}`,
    `state     ${job.state}`,
    `cwd       ${job.cwd}`,
    `session   ${job.sessionId || '(discovering…)'}`,
    `started   ${new Date(job.startedAt).toISOString()}  elapsed=${humanDuration((job.finishedAt || Date.now()) - job.startedAt)}`,
  ]
  if (job.updateCount) lines.push(`updates   ${job.updateCount} (last ${new Date(job.lastUpdateAt).toISOString()})`)
  if (typeof job.deferredUntil === 'number' && job.state === 'scheduled') {
    const remaining = job.deferredUntil - Date.now()
    lines.push(`deferred  starts ${new Date(job.deferredUntil).toISOString()} (off-peak)`
      + (remaining > 0 ? `, in ${humanDuration(remaining)}` : ', any moment now'))
  }
  if (job.stopReason) lines.push(`stop      ${job.stopReason}`)
  if (job.workspace) lines.push(`workspace ${job.workspace}`)
  if (job.mcpConfig) lines.push(`mcp       ${job.mcpConfig}`)
  else lines.push('mcp       (none)')
  if (job.error) lines.push(`error     ${job.error.split('\n')[0]}`)
  if (job.resultFile) lines.push(`result    ${job.resultFile}`)
  lines.push(`follow    ${followCommand(job.jobId)}`)
  lines.push(`gui       ${GUI_URL}  → session list for ${job.cwd} (row stays idle while the job runs)`)
  if (!full && job.sessionId) lines.push('', `next      dsh-offload result ${job.jobId}`)
  return lines.join('\n')
}

async function commandStart(positional, flags) {
  ensureDirs()
  const prompt = positional.join(' ').trim()
  const cwd = typeof flags.cwd === 'string' ? flags.cwd : DEFAULT_CWD
  if (prompt === '') fail('start requires a prompt: dsh-offload start "<self-contained task>"')
  if (!isAbsolutePath(cwd)) fail(`--cwd must be absolute: ${cwd}`)
  if (!fs.existsSync(cwd)) fail(`--cwd does not exist: ${cwd}`)
  if (!fs.existsSync(BRIDGE_SERVER)) fail(`bridge server not found: ${BRIDGE_SERVER}`)

  let mcpConfig = typeof flags['mcp-config'] === 'string' ? flags['mcp-config'] : process.env.DEEPSEEK_MCP_CONFIG || null
  if (mcpConfig !== null && mcpConfig !== '') {
    if (!isAbsolutePath(mcpConfig)) fail(`--mcp-config must be absolute: ${mcpConfig}`)
    if (!fs.existsSync(mcpConfig)) fail(`--mcp-config does not exist: ${mcpConfig}`)
  } else {
    mcpConfig = null
  }

  const now = Date.now()
  const deferredUntil = flags['defer-to-off-peak'] === true && isPeakAt(now) ? nextOffPeakStart(now) : null

  const jobId = newJobId()
  const record = {
    jobId,
    label: typeof flags.label === 'string' ? flags.label : null,
    state: 'starting',
    prompt,
    cwd,
    mcpConfig,
    permission: typeof flags.permission === 'string' ? flags.permission : DEFAULT_PERMISSION,
    timeoutMs: typeof flags['timeout-ms'] === 'string' ? Number(flags['timeout-ms']) : DEFAULT_TIMEOUT_MS,
    sessionId: null,
    startedAt: now,
    finishedAt: null,
    elapsedMs: null,
    stopReason: null,
    error: null,
    progressChars: 0,
    host: `${process.platform} ${process.arch}`,
    bridge: path.relative(PROJECT_ROOT, BRIDGE_SERVER),
    ...(deferredUntil === null ? {} : { deferredUntil }),
  }
  writeJsonAtomic(jobFile(jobId), record)

  const log = fs.openSync(workerLogFile(jobId), 'a')
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), '__run', jobId], {
    cwd: PROJECT_ROOT,
    env: process.env,
    detached: true,
    stdio: ['ignore', log, log],
  })
  worker.unref()
  fs.closeSync(log)
  writeJsonAtomic(jobFile(jobId), { ...record, state: deferredUntil === null ? 'running' : 'scheduled', pid: worker.pid })

  if (deferredUntil !== null) {
    const job = readJob(jobId)
    if (flags.json === true) {
      print({ ...job, resultFile: null, followUrl: `${GUI_URL}/#sessions`, followCommand: followCommand(job.jobId) }, true)
      return 0
    }
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    process.stdout.write(`${describeJob(job)}\n`)
    process.stdout.write(
      `\nnote      currently peak pricing — deferred to off-peak, starts `
      + `${formatLocal(deferredUntil, tz)} (${tz}) = ${new Date(deferredUntil).toISOString()} `
      + `(in ${humanDuration(deferredUntil - now)}). \`cancel ${jobId}\` drops it before then.\n`,
    )
    return 0
  }

  // Hand the caller a followable session id as soon as the worker discovers it.
  const waitMs = flags.detach === true ? 0 : Number(typeof flags['wait-session-ms'] === 'string' ? flags['wait-session-ms'] : 25_000)
  const deadline = Date.now() + Math.max(0, waitMs)
  let job = readJob(jobId)
  while (job.sessionId === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    job = readJob(jobId)
    if (job.state === 'done' || job.state === 'error') break
  }

  if (flags.json === true) {
    print({ ...job, resultFile: job.resultFile ?? null, followUrl: `${GUI_URL}/#sessions`, followCommand: followCommand(job.jobId) }, true)
    return 0
  }
  process.stdout.write(`${describeJob(job)}\n`)
  if (job.sessionId === null) {
    process.stdout.write(
      `\nnote      session id not discovered yet; re-run \`status ${jobId}\` in ~15s.\n`
      + `          the job keeps running in the background regardless.\n`,
    )
  }
  return 0
}

function commandStatus(positional, flags) {
  ensureDirs()
  const jobId = positional[0]
  if (jobId === undefined) fail('status requires a job id')
  const job = reconcileJob(readJob(jobId))
  if (flags.json === true) {
    print(job, true)
    return 0
  }
  process.stdout.write(`${describeJob(job)}\n`)
  if (job.state === 'running') {
    process.stdout.write(`progress  ${job.progressChars} chars streamed at last notification\n`)
    process.stdout.write('\nThe GUI lists this session but cannot show it running; follow it with:\n')
    process.stdout.write(`  ${followCommand(jobId)}\n`)
  }
  if (flags.log === true && fs.existsSync(workerLogFile(jobId))) {
    process.stdout.write(`\n--- worker log ---\n${fs.readFileSync(workerLogFile(jobId), 'utf8')}`)
  }
  return 0
}

function commandResult(positional, flags) {
  ensureDirs()
  const jobId = positional[0]
  if (jobId === undefined) fail('result requires a job id')
  const job = reconcileJob(readJob(jobId))
  const file = resultFile(jobId)
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (flags.json === true) {
    print({ jobId, state: job.state, sessionId: job.sessionId, stopReason: job.stopReason ?? null, elapsedMs: job.elapsedMs ?? null, result: text }, true)
    return job.state === 'error' ? 1 : 0
  }
  if (isActiveState(job.state)) {
    process.stdout.write(`job ${jobId} is still ${job.state}; no result yet.\n${describeJob(job)}\n`)
    return 2
  }
  process.stdout.write(`${describeJob(job)}\n\n--- result ---\n${text === '' ? '(no output captured)\n' : text}`)
  return job.state === 'error' ? 1 : 0
}

/**
 * Deliver new information / a course correction to a still-running job by
 * relaying it over the worker's socket to the live DeepSeek session.
 * @param positional - `[jobId, ...messageWords]`.
 * @param flags - `--json` prints the response object.
 * @returns process exit code: 0 delivered, 1 failed or rejected.
 */
async function commandUpdate(positional, flags) {
  ensureDirs()
  const jobId = positional[0]
  const message = positional.slice(1).join(' ').trim()
  if (jobId === undefined) fail('update requires a job id: dsh-offload update <jobId> "<new information>"')
  if (message === '') fail(`update requires a message: dsh-offload update ${jobId} "<new information>"`)
  const job = reconcileJob(readJob(jobId))
  if (job.state !== 'running') {
    const hint = job.state === 'scheduled' ? ' (still waiting for its off-peak window — use `cancel` to drop it instead)' : ''
    fail(`job ${jobId} is not running (state=${job.state}) — nothing to steer${hint}`)
  }

  let response
  try {
    response = await sendSocketRequest(jobSocketFile(jobId), { message })
  } catch (error) {
    const detail = error && error.message ? error.message : String(error)
    if (flags.json === true) {
      print({ jobId, ok: false, error: detail }, true)
      return 1
    }
    process.stderr.write(`dsh-offload: update failed: ${detail}\n`)
    return 1
  }
  if (!response.ok) {
    const detail = response.error || 'unknown error'
    if (flags.json === true) {
      print({ jobId, ok: false, error: detail }, true)
      return 1
    }
    process.stderr.write(`dsh-offload: update rejected: ${detail}\n`)
    return 1
  }
  if (flags.json === true) {
    print({ jobId, ok: true, sessionId: job.sessionId, message }, true)
    return 0
  }
  process.stdout.write(`update delivered to job ${jobId} (session ${job.sessionId}).\n`)
  return 0
}

/**
 * Escalating stop for a worker that didn't respond to the graceful cancel: SIGTERM the
 * whole process group first (the worker is a detached group leader, so this also reaches
 * its private bridge child and that bridge's `dsh --profile acp` grandchild), then SIGKILL
 * after a short grace period if anything is still alive.
 * @param pid - the worker's own pid (its process-group id, since it was spawned detached).
 */
async function forceKillWorkerTree(pid) {
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const tryKill = (target, signal) => {
    try {
      process.kill(target, signal)
    } catch {
      /* already gone, or this platform/pid has no such process group */
    }
  }
  tryKill(-pid, 'SIGTERM')
  tryKill(pid, 'SIGTERM')
  const deadline = Date.now() + 3_000
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200))
  if (alive()) {
    tryKill(-pid, 'SIGKILL')
    tryKill(pid, 'SIGKILL')
  }
}

/**
 * Stop a running job outright — no redirect message, unlike `update`. Tries a graceful
 * cancel through the worker's socket first (interrupts the live session cleanly, the
 * worker settles to `state: cancelled` on its own); falls back to killing the worker's
 * process tree directly if the socket is unreachable or rejects.
 * @param positional - `[jobId]`.
 * @param flags - `--json` prints the response object.
 * @returns process exit code: 0 cancelled (or already finished), 1 on failure.
 */
async function commandCancel(positional, flags) {
  ensureDirs()
  const jobId = positional[0]
  if (jobId === undefined) fail('cancel requires a job id: dsh-offload cancel <jobId>')
  let job = reconcileJob(readJob(jobId))

  if (!isActiveState(job.state)) {
    if (flags.json === true) {
      print({ jobId, ok: true, alreadyState: job.state }, true)
      return 0
    }
    process.stdout.write(`job ${jobId} is already ${job.state} — nothing to cancel.\n`)
    return 0
  }

  let graceful = false
  let gracefulError = null
  try {
    const response = await sendSocketRequest(jobSocketFile(jobId), { cancel: true })
    graceful = response.ok === true
    if (!graceful) gracefulError = response.error || 'unknown error'
  } catch (error) {
    gracefulError = error && error.message ? error.message : String(error)
  }

  if (graceful) {
    // Give the worker a moment to settle to a terminal state on disk before reporting.
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      job = reconcileJob(readJob(jobId))
      if (!isActiveState(job.state)) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (flags.json === true) {
      print({ jobId, ok: true, mode: 'graceful', state: job.state }, true)
      return 0
    }
    process.stdout.write(isActiveState(job.state)
      ? `cancel requested for job ${jobId}; it hasn't settled yet — check \`status ${jobId}\` shortly.\n`
      : `job ${jobId} cancelled gracefully (state=${job.state}).\n`)
    return 0
  }

  // The graceful path failed (no live socket, or the bridge rejected it) — force-stop.
  if (typeof job.pid === 'number') await forceKillWorkerTree(job.pid)
  updateJob(jobId, { state: 'cancelled', error: null, finishedAt: Date.now() })
  try {
    fs.unlinkSync(jobSocketFile(jobId))
  } catch {
    /* already gone */
  }
  if (flags.json === true) {
    print({ jobId, ok: true, mode: 'force-killed', gracefulError }, true)
    return 0
  }
  process.stdout.write(
    `job ${jobId} force-cancelled (graceful cancel unavailable: ${gracefulError}).\n`,
  )
  return 0
}

async function commandWait(positional, flags) {
  ensureDirs()
  const jobId = positional[0]
  if (jobId === undefined) fail('wait requires a job id')
  const timeoutMs = Number(typeof flags['timeout-ms'] === 'string' ? flags['timeout-ms'] : 15 * 60 * 1000)
  const deadline = Date.now() + timeoutMs
  let job = reconcileJob(readJob(jobId))
  // A wait can last as long as the job does, and a caller watching this
  // process (a terminal, an agent's shell panel) sees nothing until it exits.
  // Print the header at once — the session id and follow link are the point of
  // waiting — then one line per state change and a heartbeat every 15s.
  const human = flags.json !== true
  if (human) process.stdout.write(`${describeJob(job, { full: true })}\n\nwaiting   for the job to settle; Ctrl-C stops waiting, not the job\n`)
  let lastState = job.state
  let lastLine = Date.now()
  while (isActiveState(job.state)) {
    if (Date.now() > deadline) {
      process.stderr.write(`dsh-offload: wait timed out after ${timeoutMs}ms; job ${jobId} is still running.\n`)
      return 2
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    job = reconcileJob(readJob(jobId))
    if (!human) continue
    const now = Date.now()
    if (job.state !== lastState) {
      process.stdout.write(`state     ${lastState} → ${job.state}  (${humanDuration(now - job.startedAt)})\n`)
      lastState = job.state
      lastLine = now
    } else if (now - lastLine >= 15_000) {
      const progress = job.progressChars ? `, progress ${job.progressChars} chars` : ''
      process.stdout.write(`waiting   ${job.state} ${humanDuration(now - job.startedAt)}${progress}\n`)
      lastLine = now
    }
  }
  if (human) process.stdout.write('\n')
  return commandResult([jobId], flags)
}

function commandList(positional, flags) {
  ensureDirs()
  const ids = listJobIds()
  const jobs = ids.map((id) => reconcileJob(readJob(id)))
  const shown = flags.all === true ? jobs : jobs.slice(0, 15)
  if (flags.json === true) {
    print(shown, true)
    return 0
  }
  if (shown.length === 0) {
    process.stdout.write('No background jobs recorded.\n')
    return 0
  }
  const rows = shown.map((job) => [
    job.jobId,
    job.state.padEnd(9),
    (job.sessionId || '-').slice(0, 8).padEnd(9),
    humanDuration((job.finishedAt || Date.now()) - job.startedAt).padEnd(7),
    (job.label || job.prompt.split('\n')[0]).slice(0, 60),
  ])
  const header = ['JOB', 'STATE'.padEnd(9), 'SESSION'.padEnd(9), 'AGE'.padEnd(7), 'TASK']
  process.stdout.write(`${[header, ...rows].map((row) => row.join('  ')).join('\n')}\n`)
  return 0
}

async function commandSessions(positional, flags) {
  const cwd = typeof flags.cwd === 'string' ? flags.cwd : undefined
  if (cwd !== undefined && !isAbsolutePath(cwd)) fail(`--cwd must be absolute: ${cwd}`)
  const text = await withBridge({}, async (bridge) => {
    const { text: output } = await bridge.callToolOrThrow('deepseek_list_sessions', cwd === undefined ? {} : { cwd }, { timeoutMs: 90_000 })
    return output
  })
  if (flags.json === true) {
    print({ sessions: parseSessionIds(text), raw: text }, true)
    return 0
  }
  process.stdout.write(`${text}\n\nGUI session list (cold — it cannot stream a running job): ${GUI_URL}\n`)
  return 0
}

/**
 * Report which MCP servers a delegation would receive, without running an agent.
 * @param positional - unused; the config path comes from the flag.
 * @param flags - `--mcp-config PATH`, defaulting to DEEPSEEK_MCP_CONFIG.
 * @returns process exit code.
 */
async function commandMcpServers(positional, flags) {
  const configPath = typeof flags['mcp-config'] === 'string'
    ? flags['mcp-config']
    : process.env.DEEPSEEK_MCP_CONFIG || ''
  if (configPath === '') {
    process.stdout.write('No MCP config given and DEEPSEEK_MCP_CONFIG is unset, so delegated sessions get no MCP tools.\n')
    return 0
  }
  if (!isAbsolutePath(configPath)) fail(`--mcp-config must be absolute: ${configPath}`)
  const text = await withBridge({}, async (bridge) => {
    const { text: output } = await bridge.callToolOrThrow('deepseek_mcp_servers', { mcpConfig: configPath }, { timeoutMs: 60_000 })
    return output
  })
  if (flags.json === true) {
    print({ mcpConfig: configPath, report: text }, true)
    return 0
  }
  process.stdout.write(`${text}\n`)
  return 0
}

/**
 * Adopt sessions the GUI never accounted into a Workspace named after the
 * directory each one ran in: the backfill for jobs created before the
 * workspace-attach plugin existed, and the repair path for a run whose
 * grouping request was queued while the GUI was down.
 *
 * Candidates are the sessions this tool recorded job files for (default) or
 * every session in the DSH store with `--all`; anything already accounted for
 * by a Workspace is skipped. Requests go through the same inbox the bridge
 * writes, using the session's recorded directory as the Workspace path — the
 * registry only accepts a session whose stored cwd IS the Workspace path.
 *
 * @param positional - unused.
 * @param flags - `--all`, `--wait-ms N`, `--dry-run`, `--json`.
 * @returns process exit code.
 */
async function commandSyncWorkspace(_positional, flags) {
  const waitMs = positiveFlag(flags['wait-ms'], 15_000)
  const accounted = accountedSessionIds()

  let candidates = []
  if (flags.all === true) {
    const text = await withBridge({}, async (bridge) => {
      const { text: output } = await bridge.callToolOrThrow('deepseek_list_sessions', {}, { timeoutMs: 90_000 })
      return output
    })
    candidates = parseSessionRows(text).map((row) => ({ ...row, source: 'store' }))
  } else {
    for (const jobId of listJobIds()) {
      try {
        const job = readJob(jobId)
        if (job.sessionId && job.cwd) candidates.push({ sessionId: job.sessionId, cwd: job.cwd, source: jobId })
      } catch {
        /* a job file being rewritten is not a reason to abort the sweep */
      }
    }
  }

  const seen = new Set()
  const pending = []
  for (const candidate of candidates) {
    if (seen.has(candidate.sessionId) || accounted.has(candidate.sessionId)) continue
    seen.add(candidate.sessionId)
    pending.push(candidate)
  }

  const heartbeat = workspaceHeartbeat()
  const guiUp = await guiReachable()

  if (flags.json !== true) {
    process.stdout.write(`inbox      ${WORKSPACE_ATTACH_DIR}\n`)
    process.stdout.write(`gui        ${guiUp ? 'running' : 'not running'} at ${GUI_URL}`
      + `, plugin ${heartbeat?.fresh === true ? `alive (pid ${heartbeat.pid})` : 'not answering'}\n`)
    process.stdout.write(`accounted  ${accounted.size} session(s) already in a workspace\n`)
  }

  if (pending.length === 0) {
    if (flags.json === true) print({ candidates: candidates.length, pending: 0, results: [] }, true)
    else process.stdout.write('nothing to adopt — every known session is already in a workspace\n')
    return 0
  }
  if (flags.json !== true) {
    process.stdout.write(`pending    ${pending.length} session(s) to adopt\n`)
    for (const candidate of pending) process.stdout.write(`  - ${candidate.sessionId}  ${candidate.cwd}\n`)
  }

  if (flags['dry-run'] === true) {
    if (flags.json === true) print({ pending, results: [], dryRun: true }, true)
    else process.stdout.write('dry run — no requests written\n')
    return 0
  }
  if (heartbeat?.fresh !== true) {
    process.stderr.write(
      `dsh-offload: the GUI plugin is not answering, so nothing will be adopted yet — `
      + `start \`dsh web\` (or activate the workspace-attach row in ${path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')})\n`,
    )
  }

  for (const candidate of pending) queueWorkspaceRequest(candidate.sessionId, candidate.cwd)
  const answers = await awaitWorkspaceResults(pending.map((candidate) => candidate.sessionId), waitMs)

  const results = pending.map((candidate) => {
    const answer = answers.get(candidate.sessionId)
    if (answer === undefined) return { ...candidate, ok: null, detail: 'no answer yet — the request stays queued' }
    return answer.ok === true
      ? { ...candidate, ok: true, workspace: answer.title, detail: `${answer.created === true ? 'created' : 'joined'} "${answer.title}"` }
      : { ...candidate, ok: false, detail: answer.error }
  })

  if (flags.json === true) {
    print({ pending: pending.length, results }, true)
  } else {
    for (const result of results) {
      const icon = result.ok === true ? 'ok  ' : result.ok === false ? 'FAIL' : 'wait'
      process.stdout.write(`${icon}  ${result.sessionId}  ${result.detail}\n`)
    }
    const adopted = results.filter((result) => result.ok === true).length
    const failed = results.filter((result) => result.ok === false).length
    process.stdout.write(`${adopted} adopted, ${failed} failed, ${results.length - adopted - failed} still queued\n`)
  }
  return results.some((result) => result.ok === false) ? 1 : 0
}

/**
 * Read a positive numeric flag.
 * @param value - raw flag value.
 * @param fallback - value used when absent or unusable.
 * @returns the parsed number or the fallback.
 */
function positiveFlag(value, fallback) {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Whether a profile patch declares image input for one catalog model id.
 * @param patchText - contents of the profile's patch file.
 * @param id - the catalog model id to look for.
 * @returns true when that model's own entry lists `image`.
 */
function catalogDeclaresImage(patchText, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lines = patchText.split('\n')
  const index = lines.findIndex(line => new RegExp(`^\\s*- id: ${escaped}\\s*$`).test(line))
  if (index < 0) return false
  const entry = []
  for (let line = index + 1; line < lines.length; line += 1) {
    if (/^\s*- id: /.test(lines[line])) break
    entry.push(lines[line])
  }
  return /inputModalities\s*:\s*\[[^\]]*image/.test(entry.join('\n'))
}

/**
 * Verify the toolchain prerequisites and the two facts that decide whether a
 * delegated session will be grouped under its project folder: the workspace
 * plugin must be answering, and the GUI must be running to answer at all.
 * @param _positional - unused.
 * @param flags - `--json`.
 * @returns process exit code; 1 when a check fails.
 */
async function commandDoctor(_positional, flags) {
  const checks = []
  const push = (name, ok, detail) => checks.push({ name, ok, detail })

  const major = Number(process.versions.node.split('.')[0])
  push('node >= 18', major >= 18, `node ${process.versions.node}`)
  push('bridge server', fs.existsSync(BRIDGE_SERVER), BRIDGE_SERVER)

  const dshHome = process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh')
  push('DSH_HOME exists', fs.existsSync(dshHome), dshHome)

  const patchFile = path.join(dshHome, 'profiles', 'acp', 'cordis.patch.yml')
  let model = null
  let patchText = ''
  if (fs.existsSync(patchFile)) {
    patchText = fs.readFileSync(patchFile, 'utf8')
    const match = /^\s*model:\s*(\S+)\s*$/m.exec(patchText)
    model = match === null ? null : match[1]
  }
  push('acp profile patch', model !== null, model === null ? `no model override in ${patchFile}` : `model=${model} (${patchFile})`)
  // A pin that names a model the provider's catalog does not carry still runs,
  // but text-only: image jobs under it are refused at the first read. The
  // provider declares the vision model itself; every other id must be declared
  // by the profile, which is what the installer's catalog row does.
  const declaredVision = new Set(['deepseek-v4-flash-vision-exp'])
  push('model accepts images', model === null || declaredVision.has(model) || catalogDeclaresImage(patchText, model), model === null
    ? 'no pinned model to check'
    : declaredVision.has(model)
      ? `model=${model} (provider catalog)`
      : catalogDeclaresImage(patchText, model)
        ? `model=${model} (declared in ${patchFile})`
        : `model=${model} does not declare image input — image jobs would be refused; add it to the llm-deepseek catalog in ${patchFile}`)
  push('job store writable', (() => {
    try {
      ensureDirs()
      const probe = path.join(JOBS_DIR, `.probe-${process.pid}`)
      fs.writeFileSync(probe, 'ok')
      fs.unlinkSync(probe)
      return true
    } catch {
      return false
    }
  })(), JOBS_DIR)

  const mcpConfig = process.env.DEEPSEEK_MCP_CONFIG || ''
  if (mcpConfig === '') {
    push('MCP config', true, 'DEEPSEEK_MCP_CONFIG unset — delegated jobs get no MCP tools')
  } else if (fs.existsSync(mcpConfig)) {
    push('MCP config', true, `${mcpConfig} (forwarded into every session)`)
  } else {
    push('MCP config', false, `DEEPSEEK_MCP_CONFIG points at a missing file: ${mcpConfig}`)
  }

  // Grouping: a GUI that runs without the plugin cannot file sessions under
  // their project, which is the failure this check exists to name.
  const heartbeat = workspaceHeartbeat()
  const guiUp = await guiReachable()
  if (heartbeat?.fresh === true) {
    push('workspace grouping', true, `plugin alive (pid ${heartbeat.pid}, ${Math.round(heartbeat.ageMs / 1000)}s ago) — sessions join their project folder`)
  } else if (guiUp) {
    push('workspace grouping', false, `${GUI_URL} is running but the workspace-attach plugin is not answering — `
      + `activate it in ${path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')}, or delegated sessions stay Ungrouped`)
  } else {
    push('workspace grouping', true, `GUI not running — adoption requests queue in ${WORKSPACE_ATTACH_DIR} and are applied when \`dsh web\` starts`)
  }

  if (flags.json === true) {
    print({ checks, ok: checks.every((check) => check.ok) }, true)
    return checks.every((check) => check.ok) ? 0 : 1
  }
  for (const check of checks) process.stdout.write(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name} — ${check.detail}\n`)
  return checks.every((check) => check.ok) ? 0 : 1
}

/**
 * Report DeepSeek's current peak/off-peak pricing window and when it next flips —
 * the planning primitive `start --defer-to-off-peak` uses internally, exposed
 * directly so a caller can decide up front whether deferring is worth it.
 * @param positional - unused.
 * @param flags - `--tz IANA_NAME` (default: system timezone), `--json`.
 * @returns 0 always.
 */
function commandWindow(_positional, flags) {
  const tz = typeof flags.tz === 'string' ? flags.tz : Intl.DateTimeFormat().resolvedOptions().timeZone
  const now = Date.now()
  const peak = isPeakAt(now)
  const info = { nowUtc: new Date(now).toISOString(), nowLocal: formatLocal(now, tz), tz, status: peak ? 'peak' : 'off-peak' }
  if (peak) {
    const boundary = nextOffPeakStart(now)
    Object.assign(info, {
      offPeakStartsUtc: new Date(boundary).toISOString(),
      offPeakStartsLocal: formatLocal(boundary, tz),
      msUntilOffPeak: boundary - now,
    })
  } else {
    const boundary = nextPeakStart(now)
    Object.assign(info, {
      peakStartsUtc: new Date(boundary).toISOString(),
      peakStartsLocal: formatLocal(boundary, tz),
      msUntilPeak: boundary - now,
    })
  }
  if (flags.json === true) {
    print(info, true)
    return 0
  }
  process.stdout.write(`now       ${info.nowLocal} (${tz})  =  ${info.nowUtc}\n`)
  process.stdout.write(`status    ${info.status}  (peak = full price, off-peak = half price)\n`)
  if (peak) {
    process.stdout.write(
      `off-peak  starts ${info.offPeakStartsLocal} (${tz})  =  ${info.offPeakStartsUtc}  (in ${humanDuration(info.msUntilOffPeak)})\n`,
    )
  } else {
    process.stdout.write(
      `peak      starts ${info.peakStartsLocal} (${tz})  =  ${info.peakStartsUtc}  (in ${humanDuration(info.msUntilPeak)})\n`,
    )
  }
  process.stdout.write('\nDeepSeek peak = 01:00-04:00 & 06:00-10:00 UTC, Mon-Fri (source: api-docs.deepseek.com/quick_start/pricing).\n')
  return 0
}

function usage() {
  process.stdout.write(`dsh-offload — background DeepSeek delegation through the MCP bridge

  doctor                       verify bridge, DSH_HOME, acp model, MCP config and job store
  window [--tz IANA] [--json]  DeepSeek peak/off-peak status now, and when it next flips
  start "<prompt>" [flags]     launch a background job; prints job id + session id
                                 --cwd DIR (absolute, default ${DEFAULT_CWD})
                                 --mcp-config FILE (Claude .mcp.json / Gemini mcp_config.json)
                                 --label NAME  --permission allow|reject
                                 --timeout-ms N  --detach  --wait-session-ms N  --json
                                 --defer-to-off-peak   if pricing is peak now, wait for
                                   off-peak before running (half price); no-op if already off-peak
  status <jobId> [--json] [--log]   job state, session id and GUI follow-up
  result <jobId> [--json]      final report text
  wait   <jobId> [--timeout-ms N]   block until the job settles, then print the result
  update <jobId> "<new info>"    steer a running job onto the right track
  cancel <jobId>                stop a running job outright, no redirect
  list   [--all] [--json]      recent jobs
  sessions [--cwd DIR] [--json]     sessions in the shared DSH store (what the GUI shows)
  sync-workspace [--all] [--dry-run] [--wait-ms N] [--json]
                               file sessions under a workspace named after the
                               directory each ran in (backfill for jobs that
                               landed in the GUI's Ungrouped bucket when
                               --all covers every session in the store)
  mcp-servers [--mcp-config FILE] [--json]   which MCP servers a job would receive

Environment: DSH_HOME, DEEPSEEK_MCP_DEFAULT_CWD, DEEPSEEK_MCP_PERMISSION,
             DEEPSEEK_MCP_TIMEOUT_MS, DEEPSEEK_MCP_CONFIG, DEEPSEEK_MCP_SKIP,
             DEEPSEEK_WORKSPACE_ATTACH (=0 to stop asking the GUI to group jobs),
             DEEPSEEK_WORKSPACE_ATTACH_DIR, DEEPSEEK_WORKSPACE_ATTACH_WAIT_MS,
             DSH_OFFLOAD_JOB_DIR, DSH_GUI_URL
`)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { positional, flags } = parseArgs(rest)

  switch (command) {
    case '__run': {
      const jobId = positional[0]
      if (jobId === undefined) fail('internal worker mode requires a job id')
      // A worker that dies without a trace must not leave the job "running" forever.
      const crash = (error) => {
        try {
          updateJob(jobId, { state: 'error', error: `worker crashed: ${error && error.message ? error.message : String(error)}`, finishedAt: Date.now() })
        } catch {
          /* the job file may be gone */
        }
        process.exit(1)
      }
      process.on('uncaughtException', crash)
      process.on('unhandledRejection', crash)
      process.exitCode = await runWorker(jobId)
      return
    }
    case 'start':
      process.exitCode = await commandStart(positional, flags)
      return
    case 'status':
      process.exitCode = commandStatus(positional, flags)
      return
    case 'result':
      process.exitCode = commandResult(positional, flags)
      return
    case 'update':
      process.exitCode = await commandUpdate(positional, flags)
      return
    case 'cancel':
      process.exitCode = await commandCancel(positional, flags)
      return
    case 'wait':
      process.exitCode = await commandWait(positional, flags)
      return
    case 'list':
      process.exitCode = commandList(positional, flags)
      return
    case 'sessions':
      process.exitCode = await commandSessions(positional, flags)
      return
    case 'mcp-servers':
      process.exitCode = await commandMcpServers(positional, flags)
      return
    case 'sync-workspace':
      process.exitCode = await commandSyncWorkspace(positional, flags)
      return
    case 'doctor':
      process.exitCode = await commandDoctor(positional, flags)
      return
    case 'window':
      process.exitCode = commandWindow(positional, flags)
      return
    case undefined:
    case 'help':
    case '--help':
      usage()
      return
    default:
      fail(`unknown command: ${command} (run \`dsh-offload help\`)`)
  }
}

try {
  await main()
} catch (error) {
  // Bridge-side failures (bad MCP config, unresolvable command) arrive with the
  // failing field already named; a stack trace here would only bury it.
  fail(error && error.message ? error.message : String(error))
}
