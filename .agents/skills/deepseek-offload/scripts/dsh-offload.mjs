#!/usr/bin/env node
/**
 * dsh-offload — fire-and-forget background delegation to a DeepSeek Harness agent.
 *
 * This is a thin MCP *client* for the existing bridge at
 * `.agents/mcp-deepseek/server.cjs`. It does not reimplement ACP: it speaks MCP
 * over stdio to that bridge, exactly like an MCP-enabled editor would, so every
 * job it starts is a real DSH session persisted to the shared session store
 * (`DSH_HOME`, default `~/.dsh`) that the DeepSeek web GUI lists.
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
 *   node dsh-offload.mjs start "<self-contained prompt>" [--cwd DIR] [--label NAME]
 *   node dsh-offload.mjs status <jobId>
 *   node dsh-offload.mjs result <jobId>
 *   node dsh-offload.mjs wait   <jobId> [--timeout-ms N]
 *   node dsh-offload.mjs list   [--all]
 *   node dsh-offload.mjs sessions [--cwd DIR]
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Paths and defaults
// ---------------------------------------------------------------------------
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
// <repo>/.agents/skills/deepseek-offload/scripts -> <repo>
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..', '..')
const BRIDGE_SERVER = path.join(REPO_ROOT, '.agents', 'mcp-deepseek', 'server.cjs')
const JOB_ROOT = process.env.DSH_OFFLOAD_JOB_DIR || path.join(REPO_ROOT, 'scratch', 'dsh-offload')
const JOBS_DIR = path.join(JOB_ROOT, 'jobs')
const DEFAULT_CWD = process.env.DEEPSEEK_MCP_DEFAULT_CWD || REPO_ROOT
const DEFAULT_PERMISSION = process.env.DEEPSEEK_MCP_PERMISSION || 'allow'
const DEFAULT_TIMEOUT_MS = Number(process.env.DEEPSEEK_MCP_TIMEOUT_MS || 15 * 60 * 1000)
const GUI_URL = process.env.DSH_GUI_URL || 'http://127.0.0.1:3080'
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
  if (job.state !== 'running' && job.state !== 'starting') return job
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
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`
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
      cwd: REPO_ROOT,
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

function parseAgentResult(text) {
  const separator = text.indexOf('\n\n')
  const header = separator === -1 ? text : text.slice(0, separator)
  const body = separator === -1 ? '' : text.slice(separator + 2)
  const match = SUMMARY_PATTERN.exec(header)
  if (match === null) return { sessionId: null, stopReason: null, elapsedMs: null, body: text }
  return {
    sessionId: match[3],
    stopReason: match[1],
    elapsedMs: Number(match[2]),
    body,
  }
}

/**
 * Session ids as the bridge prints them: the store holds both bare uuids and
 * legacy `session-<uuid>` directory names, so never assume one id form.
 */
const SESSION_LINE_PATTERN = /^-\s+(\S+)\s+cwd=/

function parseSessionIds(text) {
  const ids = []
  for (const line of text.split('\n')) {
    const match = SESSION_LINE_PATTERN.exec(line.trim())
    if (match !== null) ids.push(match[1])
  }
  return ids
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
// Worker: owns one background job
// ---------------------------------------------------------------------------
async function runWorker(jobId) {
  const job = readJob(jobId)
  const startedAt = job.startedAt
  let bridge
  try {
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
      .then((value) => ({ value }))
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
      finishedAt,
      elapsedMs: finishedAt - startedAt,
      resultFile: path.relative(REPO_ROOT, resultFile(jobId)),
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
    if (bridge !== undefined) await bridge.dispose()
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
  if (job.stopReason) lines.push(`stop      ${job.stopReason}`)
  if (job.mcpConfig) lines.push(`mcp       ${job.mcpConfig}`)
  else lines.push('mcp       (none)')
  if (job.error) lines.push(`error     ${job.error.split('\n')[0]}`)
  if (job.resultFile) lines.push(`result    ${job.resultFile}`)
  lines.push(`follow    ${GUI_URL}  → session list for ${job.cwd}`)
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
    startedAt: Date.now(),
    finishedAt: null,
    elapsedMs: null,
    stopReason: null,
    error: null,
    progressChars: 0,
    host: `${process.platform} ${process.arch}`,
    bridge: path.relative(REPO_ROOT, BRIDGE_SERVER),
  }
  writeJsonAtomic(jobFile(jobId), record)

  const log = fs.openSync(workerLogFile(jobId), 'a')
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), '__run', jobId], {
    cwd: REPO_ROOT,
    env: process.env,
    detached: true,
    stdio: ['ignore', log, log],
  })
  worker.unref()
  fs.closeSync(log)
  writeJsonAtomic(jobFile(jobId), { ...record, state: 'running', pid: worker.pid })

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
    print({ ...job, resultFile: job.resultFile ?? null, followUrl: `${GUI_URL}/#sessions` }, true)
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
    process.stdout.write(`\nThe session is live in the web GUI; open it to watch the run in real time.\n`)
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
  if (job.state === 'running' || job.state === 'starting') {
    process.stdout.write(`job ${jobId} is still ${job.state}; no result yet.\n${describeJob(job)}\n`)
    return 2
  }
  process.stdout.write(`${describeJob(job)}\n\n--- result ---\n${text === '' ? '(no output captured)\n' : text}`)
  return job.state === 'error' ? 1 : 0
}

async function commandWait(positional, flags) {
  ensureDirs()
  const jobId = positional[0]
  if (jobId === undefined) fail('wait requires a job id')
  const timeoutMs = Number(typeof flags['timeout-ms'] === 'string' ? flags['timeout-ms'] : 15 * 60 * 1000)
  const deadline = Date.now() + timeoutMs
  let job = reconcileJob(readJob(jobId))
  while (job.state === 'running' || job.state === 'starting') {
    if (Date.now() > deadline) {
      process.stderr.write(`dsh-offload: wait timed out after ${timeoutMs}ms; job ${jobId} is still running.\n`)
      return 2
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    job = reconcileJob(readJob(jobId))
  }
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
  process.stdout.write(`${text}\n\nGUI: ${GUI_URL}\n`)
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

function commandDoctor(_positional, flags) {
  const checks = []
  const push = (name, ok, detail) => checks.push({ name, ok, detail })

  const major = Number(process.versions.node.split('.')[0])
  push('node >= 18', major >= 18, `node ${process.versions.node}`)
  push('bridge server', fs.existsSync(BRIDGE_SERVER), BRIDGE_SERVER)

  const dshHome = process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh')
  push('DSH_HOME exists', fs.existsSync(dshHome), dshHome)

  const patchFile = path.join(dshHome, 'profiles', 'acp', 'cordis.patch.yml')
  let model = null
  if (fs.existsSync(patchFile)) {
    const patch = fs.readFileSync(patchFile, 'utf8')
    const match = /^\s*model:\s*(\S+)\s*$/m.exec(patch)
    model = match === null ? null : match[1]
  }
  push('acp profile patch', model !== null, model === null ? `no model override in ${patchFile}` : `model=${model} (${patchFile})`)
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

  if (flags.json === true) {
    print({ checks, ok: checks.every((check) => check.ok) }, true)
    return checks.every((check) => check.ok) ? 0 : 1
  }
  for (const check of checks) process.stdout.write(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name} — ${check.detail}\n`)
  return checks.every((check) => check.ok) ? 0 : 1
}

function usage() {
  process.stdout.write(`dsh-offload — background DeepSeek delegation through .agents/mcp-deepseek/server.cjs

  doctor                       verify bridge, DSH_HOME, acp model, MCP config and job store
  start "<prompt>" [flags]     launch a background job; prints job id + session id
                                 --cwd DIR (absolute, default ${DEFAULT_CWD})
                                 --mcp-config FILE (Claude .mcp.json / Gemini mcp_config.json)
                                 --label NAME  --permission allow|reject
                                 --timeout-ms N  --detach  --wait-session-ms N  --json
  status <jobId> [--json] [--log]   job state, session id and GUI follow-up
  result <jobId> [--json]      final report text
  wait   <jobId> [--timeout-ms N]   block until the job settles, then print the result
  list   [--all] [--json]      recent jobs
  sessions [--cwd DIR] [--json]     sessions in the shared DSH store (what the GUI shows)
  mcp-servers [--mcp-config FILE] [--json]   which MCP servers a job would receive

Environment: DSH_HOME, DEEPSEEK_MCP_DEFAULT_CWD, DEEPSEEK_MCP_PERMISSION,
             DEEPSEEK_MCP_TIMEOUT_MS, DEEPSEEK_MCP_CONFIG, DEEPSEEK_MCP_SKIP,
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
    case 'doctor':
      process.exitCode = commandDoctor(positional, flags)
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
