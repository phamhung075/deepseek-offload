#!/usr/bin/env node
'use strict'

/**
 * deepseek-mcp — a Model Context Protocol (MCP) stdio server that lets an
 * MCP client (e.g. Google Antigravity CLI) delegate work to a DeepSeek Harness
 * agent over the Agent Client Protocol (ACP).
 *
 * - Speaks MCP (JSON-RPC 2.0, newline-delimited) on stdin/stdout.
 * - Spawns `dsh --profile acp` and speaks ACP (JSON-RPC 2.0, newline-delimited)
 *   on the child's stdin/stdout.
 * - Uses the SAME DSH_HOME as the DeepSeek web GUI, so every session created
 *   here is persisted to the shared session store and appears in the web GUI's
 *   session list.
 *
 * Logs go to stderr only; stdout carries MCP protocol traffic only.
 */

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')

// ---------------------------------------------------------------------------
// Configuration (env-overridable)
// ---------------------------------------------------------------------------
const DSH_ROOT = resolveDshRoot()
// Must match the web GUI's DSH_HOME so sessions land in the shared store.
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DEFAULT_CWD = process.env.DEEPSEEK_MCP_DEFAULT_CWD || process.cwd()
// 'allow' selects the first allow option for permission prompts; 'reject' denies them.
const PERMISSION = (process.env.DEEPSEEK_MCP_PERMISSION || 'allow').toLowerCase()
const TIMEOUT_MS = Number(process.env.DEEPSEEK_MCP_TIMEOUT_MS || 15 * 60 * 1000)
// Default MCP config file (Claude Code .mcp.json or Gemini .agents/mcp_config.json shape).
const DEFAULT_MCP_CONFIG = process.env.DEEPSEEK_MCP_CONFIG || ''
// Server names never forwarded; the bridge itself is excluded to prevent recursion.
const MCP_SKIP_NAMES = new Set(
  (process.env.DEEPSEEK_MCP_SKIP || 'deepseek').split(',').map((entry) => entry.trim()).filter(Boolean),
)

const SERVER_NAME = 'deepseek-mcp'
const SERVER_VERSION = '0.2.0'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function log(...args) {
  process.stderr.write(args.map(String).join(' ') + '\n')
}

function writeMsg(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function isAbsolutePath(p) {
  return typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p))
}

/** Resolve an executable name against PATH. */
function whichSync(name) {
  const entries = (process.env.PATH || '').split(path.delimiter)
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  for (const dir of entries) {
    if (dir === '') continue
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        // keep looking
      }
    }
  }
  return null
}

/**
 * Conventional Harness checkout locations, probed in order. `$DSH_ROOT` wins
 * outright; the rest are conventions so a checkout does not have to be
 * announced.
 * @returns the first existing candidate, or the first convention when none exists.
 */
function resolveDshRoot() {
  const candidates = [
    process.env.DSH_ROOT,
    path.join(os.homedir(), 'deepseek-harness'),
    path.join(os.homedir(), 'projects', 'deepseek-harness'),
    path.join(os.homedir(), 'src', 'deepseek-harness'),
    path.join(os.homedir(), '__projects__', 'deepseek-harness'),
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && fs.existsSync(candidate)) return candidate
  }
  return path.join(os.homedir(), 'deepseek-harness')
}

/**
 * How to start one ACP session: an installed `dsh` when there is one, otherwise
 * a source checkout driven through its own launcher — a development checkout
 * resolves its profiles and plugins only through that launcher.
 * @returns command, argv, and working directory for the ACP child.
 */
function resolveDshLaunch() {
  const explicit = process.env.DSH_BIN
  if (explicit !== undefined && explicit !== '') {
    return { command: explicit, args: ['--profile', 'acp'], cwd: process.cwd() }
  }
  const onPath = whichSync('dsh')
  if (onPath !== null) return { command: onPath, args: ['--profile', 'acp'], cwd: process.cwd() }
  return {
    command: process.execPath,
    args: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'acp'],
    cwd: DSH_ROOT,
  }
}

// ---------------------------------------------------------------------------
// MCP server forwarding (Claude Code / Gemini client config -> ACP declarations)
// ---------------------------------------------------------------------------
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Substitute ${VAR} from the bridge's environment; an unset reference fails loud. */
function expandEnv(value, field) {
  return value.replace(ENV_REFERENCE, (_match, name) => {
    const resolved = process.env[name]
    if (resolved === undefined || resolved === '') {
      throw new Error(`${field} references unset environment variable ${name}`)
    }
    return resolved
  })
}

/** ACP requires an absolute stdio command; resolve bare names against PATH. */
function resolveExecutable(command) {
  if (isAbsolutePath(command)) return command
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      /* keep searching PATH */
    }
  }
  throw new Error(`command "${command}" is not an absolute path and was not found on PATH`)
}

/** Read a client-shaped MCP config: { mcpServers: {...} } or a bare server map. */
function readMcpConfig(configPath) {
  const resolvedPath = path.resolve(configPath)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read MCP config ${resolvedPath}: ${error.message}`)
  }
  const map = parsed && typeof parsed === 'object' && parsed.mcpServers !== undefined ? parsed.mcpServers : parsed
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error(`MCP config ${resolvedPath} does not contain a server map`)
  }
  return { configPath: resolvedPath, map }
}

/** True when a stdio server declares this bridge, which would recurse. */
function isSelfReference(server) {
  if (server.command === undefined) return false
  let self
  try {
    self = fs.realpathSync(__filename)
  } catch {
    return false
  }
  return server.args.some((arg) => {
    try {
      return fs.realpathSync(path.resolve(arg)) === self
    } catch {
      return false
    }
  })
}

/**
 * Translate one client-shaped server entry into a standard ACP declaration.
 * @param name - declared server name, used as the tool namespace.
 * @param entry - stdio ({command,args,env}) or HTTP ({type:'http',url,headers}) entry.
 * @returns the ACP declaration for `session/new`.
 */
function toAcpServer(name, entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`mcpServers.${name} must be an object`)
  }
  const declaredType = typeof entry.type === 'string' ? entry.type : undefined
  const wantsHttp = declaredType === 'http' || (declaredType === undefined && typeof entry.url === 'string')
  if (wantsHttp) {
    const url = expandEnv(String(entry.url === undefined ? '' : entry.url), `mcpServers.${name}.url`)
    if (!/^https?:\/\//.test(url)) throw new Error(`mcpServers.${name}.url must be an absolute HTTP(S) URL`)
    const headers = Object.entries(entry.headers || {}).map(([header, value]) => ({
      name: header,
      value: expandEnv(String(value), `mcpServers.${name}.headers.${header}`),
    }))
    return { name, type: 'http', url, headers }
  }
  if (declaredType !== undefined && declaredType !== 'stdio') {
    throw new Error(`mcpServers.${name}.type "${declaredType}" is not supported (stdio and http only)`)
  }
  if (typeof entry.command !== 'string' || entry.command.trim() === '') {
    throw new Error(`mcpServers.${name} needs a "command" or a "url"`)
  }
  const command = resolveExecutable(expandEnv(entry.command, `mcpServers.${name}.command`))
  const args = (Array.isArray(entry.args) ? entry.args : []).map((arg, index) =>
    expandEnv(String(arg), `mcpServers.${name}.args[${index}]`))
  const env = Object.entries(entry.env || {}).map(([key, value]) => ({
    name: key,
    value: expandEnv(String(value), `mcpServers.${name}.env.${key}`),
  }))
  return { name, command, args, env }
}

/**
 * Resolve every forwardable server from a client-shaped MCP config.
 * @param configPath - path to a Claude Code .mcp.json or Gemini mcp_config.json.
 * @returns the ACP declarations plus skipped names and warnings for the caller.
 */
function resolveMcpServers(configPath) {
  const { configPath: resolvedPath, map } = readMcpConfig(configPath)
  const servers = []
  const skipped = []
  const warnings = []
  for (const [name, entry] of Object.entries(map)) {
    if (MCP_SKIP_NAMES.has(name)) {
      skipped.push(`${name} (skip list)`)
      continue
    }
    let server
    try {
      server = toAcpServer(name, entry)
    } catch (error) {
      throw new Error(`MCP config ${resolvedPath}: ${error.message}`)
    }
    if (isSelfReference(server)) {
      skipped.push(`${name} (points back at this bridge)`)
      continue
    }
    if (entry && typeof entry === 'object' && entry.cwd !== undefined) {
      // ACP fixes stdio servers to the session cwd, so a declared cwd cannot be honored.
      warnings.push(`${name}: cwd "${entry.cwd}" ignored; stdio servers use the session cwd`)
    }
    servers.push(server)
  }
  return { configPath: resolvedPath, servers, skipped, warnings }
}

/** Human-readable one-line summary of resolved servers, for results and logs. */
function describeMcpServers(resolved) {
  if (resolved === null) return 'MCP servers: (none)'
  const names = resolved.servers.map((server) => `${server.name}${server.type === 'http' ? ' [http]' : ''}`)
  const parts = [`MCP servers: ${names.length === 0 ? '(none)' : names.join(', ')}`, `config=${resolved.configPath}`]
  if (resolved.skipped.length > 0) parts.push(`skipped=${resolved.skipped.join(', ')}`)
  for (const warning of resolved.warnings) parts.push(`warning: ${warning}`)
  return parts.join(' | ')
}

// ---------------------------------------------------------------------------
// Workspace grouping (ask the web GUI to file the session under its project)
// ---------------------------------------------------------------------------
// The web GUI groups sessions by Workspace, and only the GUI process may write
// that account: a Workspace's durable state is authoritative in memory, so an
// out-of-process writer would be invisible and then overwritten. A session
// created here therefore lands in the GUI's trailing "Ungrouped" bucket unless
// the GUI is asked to adopt it. The request goes through a file inbox that the
// `dsh-workspace-attach` plugin (web profile) drains; see
// `plugin/dsh-workspace-attach/README.md` for the protocol.
const WORKSPACE_ATTACH = process.env.DEEPSEEK_WORKSPACE_ATTACH !== '0'
const WORKSPACE_ATTACH_DIR = process.env.DEEPSEEK_WORKSPACE_ATTACH_DIR
  || path.join(DSH_HOME, 'workspace-attach')
const WORKSPACE_ATTACH_WAIT_MS = Number(process.env.DEEPSEEK_WORKSPACE_ATTACH_WAIT_MS || 2500)
/** A heartbeat older than this means the GUI is gone or the plugin stopped. */
const WORKSPACE_ATTACH_HEARTBEAT_MS = 30000

const WORKSPACE_ATTACH_HINT = 'install/activate the workspace-attach plugin in the web profile, or set DEEPSEEK_WORKSPACE_ATTACH=0 to silence this'

/** Request file the plugin drains; session ids are validated before naming a file. */
function attachRequestPath(sessionId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
    throw new Error(`refusing to queue a workspace request for suspicious session id ${JSON.stringify(sessionId)}`)
  }
  return path.join(WORKSPACE_ATTACH_DIR, `${sessionId}.request.json`)
}

/** Result file the plugin publishes for a processed request. */
function attachResultPath(sessionId) {
  return path.join(WORKSPACE_ATTACH_DIR, `${sessionId}.result.json`)
}

/** Read a JSON file, treating "absent" and "unreadable" alike. */
function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write JSON through a temp file so the plugin never reads a partial request. */
function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

/**
 * The repository root of a directory, for the request's diagnostics: a job run
 * in a subdirectory still joins the workspace of the directory it ran in,
 * because the registry only accepts a session whose stored cwd IS the
 * workspace path.
 */
function projectRootOf(cwd) {
  try {
    const out = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
    })
    const root = out.status === 0 && typeof out.stdout === 'string' ? out.stdout.trim() : ''
    return root === '' ? cwd : root
  } catch {
    return cwd
  }
}

/** Queue one adoption request; returns the request file path. */
function queueWorkspaceAttach(sessionId, cwd) {
  const file = attachRequestPath(sessionId)
  fs.mkdirSync(WORKSPACE_ATTACH_DIR, { recursive: true })
  const root = projectRootOf(cwd)
  writeJsonAtomic(file, {
    v: 1,
    sessionId,
    path: cwd,
    requestedAt: new Date().toISOString(),
    requestedBy: SERVER_NAME,
    ...(root === cwd ? {} : { root, nested: true }),
  })
  return file
}

/** Poll for the plugin's answer to one queued request. */
async function awaitWorkspaceAttach(sessionId, timeoutMs) {
  const file = attachResultPath(sessionId)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = readJsonIfPresent(file)
    if (result !== undefined) return result
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => { setTimeout(resolve, 100) })
  }
}

/** Report whether the GUI-side plugin answered recently enough to be trusted. */
function workspacePluginHeartbeat() {
  const beat = readJsonIfPresent(path.join(WORKSPACE_ATTACH_DIR, 'heartbeat.json'))
  if (beat === undefined || typeof beat.at !== 'string') return undefined
  const age = Date.now() - Date.parse(beat.at)
  return Number.isFinite(age) && age <= WORKSPACE_ATTACH_HEARTBEAT_MS ? beat : undefined
}

/**
 * One status line describing where this session sits in the GUI's grouping —
 * the whole point being that a caller (and the user reading the transcript)
 * learns why a job is or is not under its project folder.
 */
function describeWorkspaceAttach(result, sessionId) {
  if (result === undefined) {
    const beat = workspacePluginHeartbeat()
    return beat === undefined
      ? `Workspace: NOT adopted — the web GUI is not running this plugin (${WORKSPACE_ATTACH_HINT}); `
        + `queued at ${attachResultPath(sessionId)}, so it is adopted when the GUI starts`
      : 'Workspace: queued — the GUI plugin has not answered yet; the session stays Ungrouped until it does'
  }
  if (result.ok === true) {
    const suffix = result.created === true ? ' (created)' : result.already === true ? ' (already accounted)' : ''
    return `Workspace: ${result.title}${suffix} — session filed under ${result.path}`
  }
  return `Workspace: NOT adopted — ${result.error}`
}

/** Queue the request before the turn and resolve its outcome after it. */
function startWorkspaceAttach(sessionId, cwd) {
  if (!WORKSPACE_ATTACH) return Promise.resolve('Workspace: skipped (DEEPSEEK_WORKSPACE_ATTACH=0)')
  let queued
  try {
    queued = queueWorkspaceAttach(sessionId, cwd)
  } catch (err) {
    return Promise.resolve(`Workspace: NOT adopted — could not queue the request: ${err.message}`)
  }
  log(`queued workspace adoption for session ${sessionId} at ${queued}`)
  return awaitWorkspaceAttach(sessionId, WORKSPACE_ATTACH_WAIT_MS)
    .then((result) => describeWorkspaceAttach(result, sessionId))
    .catch((err) => `Workspace: NOT adopted — ${err.message}`)
}

// ---------------------------------------------------------------------------
// ACP client (talks to `dsh --profile acp`)
// ---------------------------------------------------------------------------
let acpNextId = 1

// sessionId -> { client: AcpClient, pendingUpdates: string[] } for sessions currently
// mid-turn in THIS process, so deepseek_update_session can reach them. A session only
// lives here while its runAgent() call is between session/new and session/close.
const activeSessions = new Map()

class AcpClient {
  constructor(permission) {
    this.permission = permission
    this.pending = new Map() // id(string) -> { resolve, reject, timer }
    this.collectedText = ''
    this.buffer = ''
    this.exited = false
    this.exitError = null
    this.onText = null // optional callback(text-so-far) for progress

    const launch = resolveDshLaunch()
    this.child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: { ...process.env, DSH_HOME },
      stdio: ['pipe', 'pipe', 'inherit'],
    })

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this._onData(chunk))
    this.child.on('error', (err) => { this.exited = true; this.exitError = err; this._failAll(err) })
    this.child.on('exit', (code) => {
      this.exited = true
      if (code !== 0 && !this.exitError) this.exitError = new Error(`dsh --profile acp exited with code ${code}`)
      this._failAll(this.exitError || new Error('dsh --profile acp exited'))
    })
  }

  _failAll(err) {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }

  _onData(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '')
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      this._onMessage(msg)
    }
  }

  _onMessage(msg) {
    if (msg && typeof msg === 'object' && typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) {
        // Server -> client request (e.g. session/request_permission)
        this._onServerRequest(msg)
      } else {
        // Notification (e.g. session/update)
        this._onNotification(msg)
      }
      return
    }
    if (msg && typeof msg === 'object' && msg.id !== undefined && msg.id !== null && typeof msg.method !== 'string') {
      // Response to one of our requests
      const p = this.pending.get(String(msg.id))
      if (p) {
        this.pending.delete(String(msg.id))
        if (p.timer) clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message || 'ACP error'))
        else p.resolve(msg.result)
      }
    }
  }

  _onNotification(msg) {
    if (msg.method === 'session/update') {
      const update = msg.params && msg.params.update
      if (update && update.sessionUpdate === 'agent_message_chunk') {
        const content = update.content
        if (content && content.type === 'text' && typeof content.text === 'string') {
          this.collectedText += content.text
          if (this.onText) this.onText(this.collectedText)
        }
      }
    }
  }

  _onServerRequest(msg) {
    if (msg.method === 'session/request_permission') {
      let result
      if (this.permission === 'allow') {
        result = { outcome: { outcome: 'selected', optionId: 'allow-once' } }
      } else {
        result = { outcome: { outcome: 'cancelled' } }
      }
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
      return
    }
    // Unknown server request: respond with a JSON-RPC error so the server can proceed.
    this.child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32601, message: `method not found: ${msg.method}` },
    }) + '\n')
  }

  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.exited) { reject(this.exitError || new Error('dsh process exited')); return }
      const id = String(acpNextId++)
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ACP request timed out after ${timeoutMs}ms: ${method}`))
      }, timeoutMs) : null
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response) — e.g. session/cancel. */
  notify(method, params) {
    if (this.exited) return
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  dispose() {
    return new Promise((resolve) => {
      if (this.exited) { resolve(); return }
      let settled = false
      const finish = () => { if (!settled) { settled = true; resolve() } }
      const kill = (sig) => { try { this.child.kill(sig) } catch {} }
      try { this.child.stdin.end() } catch {}
      const hard = setTimeout(() => {
        kill('SIGTERM')
        setTimeout(() => { kill('SIGKILL'); finish() }, 3000)
      }, 6000)
      this.child.once('exit', () => { clearTimeout(hard); finish() })
      this.child.once('error', () => { clearTimeout(hard); finish() })
    })
  }
}

// ---------------------------------------------------------------------------
// ACP operations
// ---------------------------------------------------------------------------
async function withAcp(permission, fn) {
  const client = new AcpClient(permission)
  try {
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 60000)
    return await fn(client)
  } finally {
    await client.dispose()
  }
}

async function runAgent({ prompt, cwd, onProgress, onSessionId, mcpConfigPath }) {
  const startedAt = Date.now()
  // Resolve before spawning ACP so a broken MCP config fails loud, not mid-turn.
  const resolvedMcp = mcpConfigPath ? resolveMcpServers(mcpConfigPath) : null
  if (resolvedMcp !== null) log(`forwarding MCP servers: ${describeMcpServers(resolvedMcp)}`)
  return withAcp(PERMISSION, async (client) => {
    client.onText = (text) => { if (onProgress) onProgress(text) }

    const { sessionId } = await client.request(
      'session/new',
      { cwd, mcpServers: resolvedMcp === null ? [] : resolvedMcp.servers },
      60000,
    )
    // A distinct, unthrottled announcement — not routed through onProgress's char-count
    // heartbeat, which a short "session <id>" string almost never crosses the threshold
    // for — so a caller can reliably capture the id while the call is still in flight.
    if (onSessionId) onSessionId(sessionId)

    // Queued as soon as the session exists so the GUI can file it under its project
    // while the turn is still running; the outcome is awaited once, at the end.
    const workspaceAttach = startWorkspaceAttach(sessionId, cwd)

    // Registered while this session is mid-turn so deepseek_update_session can find it,
    // queue a follow-up message, and interrupt the current session/prompt via session/cancel.
    const record = { client, pendingUpdates: [] }
    activeSessions.set(sessionId, record)

    let stopReason = 'end_turn'
    let currentPrompt = prompt
    try {
      for (;;) {
        let result
        try {
          result = await client.request(
            'session/prompt',
            { sessionId, prompt: [{ type: 'text', text: currentPrompt }] },
            TIMEOUT_MS,
          )
        } catch (err) {
          // Surface a partial answer plus the failure instead of losing the work.
          // The grouping line rides along: a failed job is exactly when someone
          // goes looking for its session in the GUI.
          const text = client.collectedText
          const prefix = text ? `DeepSeek returned partial output before failing:\n\n${text}\n\n---\n` : ''
          throw new Error(`${prefix}DeepSeek agent run failed: ${err.message}\n${await workspaceAttach}`)
        }
        stopReason = result && result.stopReason ? result.stopReason : 'end_turn'
        // A queued update — from a natural stop, or from session/cancel interrupting this
        // turn — becomes the next session/prompt on the same session, so history carries over.
        const next = record.pendingUpdates.length > 0 ? record.pendingUpdates.shift() : undefined
        if (next === undefined) break
        currentPrompt = next
      }
    } finally {
      // Delete before session/close: an update landing in that narrow window should see
      // "not active" rather than a false "queued" that nothing will ever read again.
      activeSessions.delete(sessionId)
    }

    let closed = false
    try { await client.request('session/close', { sessionId }, 30000); closed = true } catch {}

    return {
      sessionId,
      cwd,
      stopReason,
      closed,
      elapsedMs: Date.now() - startedAt,
      text: client.collectedText,
      mcp: describeMcpServers(resolvedMcp),
      workspace: await workspaceAttach,
    }
  })
}

async function listSessions({ cwd }) {
  return withAcp(PERMISSION, async (client) => {
    const params = {}
    if (cwd) params.cwd = cwd
    const result = await client.request('session/list', params, 60000)
    return result || { sessions: [] }
  })
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'deepseek_agent',
    description:
      'Delegate a self-contained task to a DeepSeek Harness agent and return its final answer. ' +
      'The work happens in a fresh DeepSeek session that is persisted to the shared store, so it ' +
      'is also visible and resumable in the DeepSeek web GUI session list. ' +
      'The returned text includes the session id. Use this when you want DeepSeek (not Gemini) to do the work.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The complete task for the DeepSeek agent.' },
        cwd: {
          type: 'string',
          description: 'Optional absolute working directory. Defaults to the configured workspace.',
        },
        mcpConfig: {
          type: 'string',
          description:
            'Optional path to an MCP client config (Claude Code .mcp.json or Gemini mcp_config.json). ' +
            'Its servers are mounted into the DeepSeek session, so the child can call tools like ' +
            'mcp__docs__extract_document. Defaults to DEEPSEEK_MCP_CONFIG when that is set.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'deepseek_mcp_servers',
    description:
      'Resolve which MCP servers a DeepSeek delegation would receive from a client-shaped MCP config ' +
      '(Claude Code .mcp.json or Gemini mcp_config.json), without running an agent. ' +
      'Reports the forwarded servers, the skipped ones, and any ignored field.',
    inputSchema: {
      type: 'object',
      properties: {
        mcpConfig: {
          type: 'string',
          description: 'Path to the MCP client config. Defaults to DEEPSEEK_MCP_CONFIG when that is set.',
        },
      },
    },
  },
  {
    name: 'deepseek_list_sessions',
    description:
      'List DeepSeek Harness sessions from the same store the DeepSeek web GUI shows, optionally filtered by working directory.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Optional absolute working directory filter.' },
      },
    },
  },
  {
    name: 'deepseek_update_session',
    description:
      'Send new information into, or cancel, a DeepSeek session that is STILL RUNNING a deepseek_agent ' +
      'call in this bridge process. With "message": steer it onto the right track instead of waiting for ' +
      'it to finish and re-delegating — interrupts the current turn (session/cancel) and re-prompts the ' +
      'same session with your message once it stops, so conversation history and work so far are ' +
      'preserved; the eventual deepseek_agent result includes everything from both turns. ' +
      'Without "message": cancels the current turn with no follow-up prompt, so the session closes ' +
      'normally and deepseek_agent returns with stopReason=cancelled — use this to stop a run outright. ' +
      'Only works for a session this same bridge process is currently holding open (see deepseek_agent\'s ' +
      'returned session id); if the session already finished, this returns an error — use ' +
      'deepseek_list_sessions or the job result instead.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The session id to steer or cancel, from deepseek_agent\'s result.' },
        message: {
          type: 'string',
          description: 'New information or corrected direction. Omit entirely to cancel with no redirect.',
        },
      },
      required: ['sessionId'],
    },
  },
]

// ---------------------------------------------------------------------------
// MCP stdio server
// ---------------------------------------------------------------------------
const KNOWN_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])

function respondResult(id, result) { writeMsg({ jsonrpc: '2.0', id, result }) }
function respondError(id, code, message) { writeMsg({ jsonrpc: '2.0', id, error: { code, message } }) }

function notifyProgress(token, progress, message) {
  if (token === undefined || token === null) return
  writeMsg({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress, total: null, message } })
}

let inflight = 0

async function handleToolsCall(id, params) {
  const name = params && params.name
  const args = (params && params.arguments) || {}
  const progressToken = params && params._meta && params._meta.progressToken

  inflight++
  try {
    if (name === 'deepseek_agent') {
      const prompt = args.prompt
      if (typeof prompt !== 'string' || prompt.trim() === '') {
        respondResult(id, { content: [{ type: 'text', text: 'Error: "prompt" (string) is required.' }], isError: true })
        return
      }
      const cwd = typeof args.cwd === 'string' && isAbsolutePath(args.cwd) ? args.cwd : DEFAULT_CWD
      const mcpConfigPath = typeof args.mcpConfig === 'string' && args.mcpConfig.trim() !== ''
        ? args.mcpConfig
        : DEFAULT_MCP_CONFIG

      let lastProgress = 0
      const onProgress = (text) => {
        if (progressToken === undefined) return
        const n = typeof text === 'string' ? text.length : lastProgress
        if (n - lastProgress >= 2000) {
          lastProgress = n
          notifyProgress(progressToken, n, 'DeepSeek agent is working…')
        }
      }
      notifyProgress(progressToken, 0, `Starting DeepSeek agent in ${cwd}…`)
      const onSessionId = (sid) => notifyProgress(progressToken, 0, `session=${sid}`)

      const out = await runAgent({ prompt, cwd, onProgress, onSessionId, mcpConfigPath })

      const header = [
        `DeepSeek agent finished (stopReason=${out.stopReason}, ${out.elapsedMs}ms, session=${out.sessionId})`,
        `Session is persisted and viewable in the DeepSeek web GUI. cwd=${out.cwd}`,
        out.mcp,
        out.workspace,
        '',
        out.text || '(no text output)',
      ].join('\n')

      respondResult(id, { content: [{ type: 'text', text: header }], isError: false })
      return
    }

    if (name === 'deepseek_mcp_servers') {
      const mcpConfigPath = typeof args.mcpConfig === 'string' && args.mcpConfig.trim() !== ''
        ? args.mcpConfig
        : DEFAULT_MCP_CONFIG
      if (mcpConfigPath === '') {
        respondResult(id, {
          content: [{ type: 'text', text: 'No MCP config given and DEEPSEEK_MCP_CONFIG is unset, so delegated sessions get no MCP tools.' }],
        })
        return
      }
      const resolved = resolveMcpServers(mcpConfigPath)
      const lines = [describeMcpServers(resolved)]
      for (const server of resolved.servers) {
        lines.push(server.type === 'http'
          ? `- ${server.name}  http  ${server.url}`
          : `- ${server.name}  stdio  ${server.command} ${server.args.join(' ')}`.trimEnd())
      }
      if (resolved.skipped.length > 0) lines.push(`skipped: ${resolved.skipped.join(', ')}`)
      for (const warning of resolved.warnings) lines.push(`warning: ${warning}`)
      respondResult(id, { content: [{ type: 'text', text: lines.join('\n') }] })
      return
    }

    if (name === 'deepseek_list_sessions') {
      const cwd = typeof args.cwd === 'string' && isAbsolutePath(args.cwd) ? args.cwd : undefined
      const result = await listSessions({ cwd })
      const sessions = Array.isArray(result.sessions) ? result.sessions : []
      if (sessions.length === 0) {
        respondResult(id, { content: [{ type: 'text', text: 'No DeepSeek sessions found.' }] })
        return
      }
      const lines = sessions.map((s) => {
        const title = s.title || '(untitled)'
        const updated = s.updatedAt || ''
        return `- ${s.sessionId}  cwd=${s.cwd}  updated=${updated}  ${title}`
      })
      respondResult(id, { content: [{ type: 'text', text: `${sessions.length} session(s):\n${lines.join('\n')}` }] })
      return
    }

    if (name === 'deepseek_update_session') {
      const sessionId = args.sessionId
      const message = typeof args.message === 'string' ? args.message.trim() : ''
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        respondResult(id, { content: [{ type: 'text', text: 'Error: "sessionId" (string) is required.' }], isError: true })
        return
      }
      const record = activeSessions.get(sessionId)
      if (!record) {
        respondResult(id, {
          content: [{ type: 'text', text:
            `Error: session ${sessionId} is not active in this bridge process — it may already have ` +
            'finished (check deepseek_list_sessions or the job result) or belongs to a different process.' }],
          isError: true,
        })
        return
      }
      // A message queues a redirect; omitting it leaves the queue empty so runAgent's
      // loop, seeing nothing pending once the cancelled turn resolves, closes the
      // session normally instead of re-prompting — a bare stop, not a steer.
      if (message !== '') record.pendingUpdates.push(message)
      record.client.notify('session/cancel', { sessionId })
      respondResult(id, {
        content: [{ type: 'text', text: message !== ''
          ? `Update queued for session ${sessionId}. Any in-flight turn is being interrupted; ` +
            'your message will be sent as the next prompt on the same session.'
          : `Cancel requested for session ${sessionId}. The in-flight turn is being interrupted with no ` +
            'follow-up prompt, so the session will close normally (stopReason=cancelled).' }],
      })
      return
    }

    respondResult(id, { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true })
  } catch (err) {
    log('tools/call error:', err && err.stack ? err.stack : String(err))
    respondResult(id, { content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }], isError: true })
  } finally {
    inflight--
    maybeExit()
  }
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return
  const method = msg.method
  const id = msg.id

  if (method === 'initialize') {
    const requested = msg.params && msg.params.protocolVersion
    const protocolVersion = KNOWN_VERSIONS.has(requested) ? requested : '2024-11-05'
    respondResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'Delegate tasks to a DeepSeek Harness agent via deepseek_agent.',
    })
    return
  }

  if (id === undefined || id === null) {
    // Notifications (no response expected)
    if (method === 'notifications/initialized') return
    if (method === 'notifications/cancelled') return
    return
  }

  switch (method) {
    case 'ping':
      respondResult(id, {})
      return
    case 'tools/list':
      respondResult(id, { tools: TOOLS })
      return
    case 'tools/call':
      handleToolsCall(id, msg.params).catch((err) => {
        respondError(id, -32603, String(err && err.message ? err.message : err))
      })
      return
    default:
      respondError(id, -32601, `method not found: ${method}`)
  }
}

let shuttingDown = false

function maybeExit() {
  if (shuttingDown && inflight === 0) {
    log('shutdown complete')
    process.exit(0)
  }
}

function start() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch { return }
    handleMessage(msg)
  })
  rl.on('close', () => { shuttingDown = true; maybeExit() })
  process.on('SIGINT', () => { shuttingDown = true; maybeExit() })
  process.on('SIGTERM', () => { shuttingDown = true; maybeExit() })
  log(`${SERVER_NAME} v${SERVER_VERSION} ready (DSH_HOME=${DSH_HOME}, permission=${PERMISSION})`)
}

start()
