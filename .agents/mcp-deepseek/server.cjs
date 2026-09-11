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

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')

// ---------------------------------------------------------------------------
// Configuration (env-overridable)
// ---------------------------------------------------------------------------
const DSH_ROOT = process.env.DSH_ROOT || path.join(os.homedir(), '__projects__/deepseek-harness')
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
// ACP client (talks to `dsh --profile acp`)
// ---------------------------------------------------------------------------
let acpNextId = 1

class AcpClient {
  constructor(permission) {
    this.permission = permission
    this.pending = new Map() // id(string) -> { resolve, reject, timer }
    this.collectedText = ''
    this.buffer = ''
    this.exited = false
    this.exitError = null
    this.onText = null // optional callback(text-so-far) for progress

    this.child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'acp'], {
      cwd: DSH_ROOT,
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

async function runAgent({ prompt, cwd, onProgress, mcpConfigPath }) {
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
    if (onProgress) onProgress(`session ${sessionId}`)

    let result
    try {
      result = await client.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: prompt }] },
        TIMEOUT_MS,
      )
    } catch (err) {
      // Surface a partial answer plus the failure instead of losing the work.
      const text = client.collectedText
      const prefix = text ? `DeepSeek returned partial output before failing:\n\n${text}\n\n---\n` : ''
      throw new Error(`${prefix}DeepSeek agent run failed: ${err.message}`)
    }

    const stopReason = result && result.stopReason ? result.stopReason : 'end_turn'
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
            'mcp__pdf2w__extract_document. Defaults to DEEPSEEK_MCP_CONFIG when that is set.',
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

      const out = await runAgent({ prompt, cwd, onProgress, mcpConfigPath })

      const header = [
        `DeepSeek agent finished (stopReason=${out.stopReason}, ${out.elapsedMs}ms, session=${out.sessionId})`,
        `Session is persisted and viewable in the DeepSeek web GUI. cwd=${out.cwd}`,
        out.mcp,
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
