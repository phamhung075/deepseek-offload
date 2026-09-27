/**
 * The `.agents/mcp-jev` worker self-check MCP server and `start --jev-mcp`.
 *
 * Every test points `TYPESAFE_API_URL` at a local HTTP stub and never calls the
 * real API. The MCP server and the runner are launched asynchronously, because
 * the stub lives in this process.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))
const MCP_JEV = fileURLToPath(new URL('../.agents/mcp-jev/server.cjs', import.meta.url))
const SECRET_KEY = 'sk-test-SECRET-KEY-1234567890'

/** A fresh root for one test; never touches the real job store or DSH home. */
function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-jev-selfcheck-${name}-`))
}

/**
 * Start a stub System One server. `handler(parsed, count)` may return
 * `{status, payload}`; otherwise a clean answer is synthesised.
 */
async function startStub(handler = () => null) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let parsed = null
      try { parsed = JSON.parse(body) } catch { /* recorded as null */ }
      requests.push(parsed)
      const override = handler(parsed, requests.length) ?? null
      const status = override?.status ?? 200
      const payload = override?.payload ?? answerFor(parsed)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/systemone`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** A clean answer set: nouls high, the first non-`none` choice picked. */
function answerFor(parsed) {
  const questions = parsed?.questions ?? {}
  const state = parsed?.state ?? {}
  const answers = {}
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria ?? {})
      const pick = options.find((option) => option !== 'none') ?? 'none'
      const probabilities = {}
      for (const option of options) probabilities[option] = option === pick ? 0.8 : 0.05
      answers[id] = { choice: pick, confidence: 0.8, probabilities }
    } else if (id === 'odd_hunk' && state.hunks) {
      const probabilities = { none: 0.9 }
      for (const hunkId of Object.keys(state.hunks)) probabilities[hunkId] = 0.05
      answers[id] = { choice: 'none', probabilities, confidence: 0.9 }
    } else {
      answers[id] = { noul: id === 'unrequested' ? 0.1 : 0.9 }
    }
  }
  return { model: 'jev-test', answers, usage: {} }
}

/**
 * Environment with a stub endpoint and a throwaway job store. A dummy key is
 * set by default so Jev is enabled; pass `{ key: null }` for the no-key path.
 */
function baseEnv(root, url, { key = SECRET_KEY } = {}) {
  const env = { ...process.env }
  delete env.TYPESAFE_API_KEY
  delete env.TYPESAFE_AI_API
  if (key !== null) env.TYPESAFE_API_KEY = key
  env.TYPESAFE_API_URL = url
  env.DSH_OFFLOAD_JOB_DIR = root
  env.DSH_HOME = path.join(root, 'dsh-home')
  env.DSH_BIN = '/bin/false'
  env.DEEPSEEK_MCP_SKIP = 'deepseek'
  env.DEEPSEEK_WORKSPACE_ATTACH = '0'
  return env
}

/** Run the runner without blocking this process's event loop (the stub lives here). */
function run(args, env, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { env, cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

/** A tiny MCP stdio client: send JSON-RPC lines, resolve replies by id. */
class McpSession {
  constructor(child) {
    this.child = child
    this.buffer = ''
    this.pending = new Map()
    this.nextId = 1
    this.stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this._onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { this.stderr += chunk })
  }

  _onData(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const waiter = this.pending.get(message.id)
      if (waiter) { this.pending.delete(message.id); waiter.resolve(message) }
    }
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  close() { this.child.kill() }
}

function startMcp(env, cwd) {
  return new McpSession(spawn(process.execPath, [MCP_JEV], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] }))
}

function numberedFile(root, name, count) {
  const lines = Array.from({ length: count }, (_value, index) => `line ${index + 1}`)
  fs.writeFileSync(path.join(root, name), `${lines.join('\n')}\n`)
}

test('mcp-jev initializes, lists its two tools, and reads claim evidence itself', async (t) => {
  const root = scratch('mcp-claims')
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  numberedFile(repo, 'code.go', 30)
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const session = startMcp(env, repo)
  t.after(() => session.close())

  const init = await session.request('initialize', { protocolVersion: '2024-11-05', clientCapabilities: {} })
  assert.equal(init.result.serverInfo.name, 'jev-mcp')
  const list = await session.request('tools/list', {})
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ['jev_check_claims', 'jev_check_scope'])

  const call = await session.request('tools/call', {
    name: 'jev_check_claims',
    arguments: {
      claims: [{ claim: 'line 12 is here', path: 'code.go', line: 12, evidence: 'CALLER SUPPLIED EVIDENCE' }],
      repo,
    },
  })
  assert.equal(call.result.isError, false)
  const report = JSON.parse(call.result.content[0].text)
  assert.equal(report.results[0].supported, 0.9)
  assert.equal(report.results[0].verdict, 'supported')

  const sent = stub.requests.find((body) => body?.questions?.supported)
  assert.ok(sent, 'the claim was sent to the stub')
  assert.match(sent.state.evidence.lines, /12: line 12/, 'the server read the working tree')
  assert.doesNotMatch(JSON.stringify(sent), /CALLER SUPPLIED EVIDENCE/, 'caller evidence is ignored')
})

test('mcp-jev tools return a disabled text result without a key', async (t) => {
  const root = scratch('mcp-disabled')
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  numberedFile(repo, 'code.go', 5)
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url, { key: null })
  const session = startMcp(env, repo)
  t.after(() => session.close())

  await session.request('initialize', { protocolVersion: '2024-11-05', clientCapabilities: {} })
  const call = await session.request('tools/call', {
    name: 'jev_check_claims',
    arguments: { claims: [{ claim: 'x', path: 'code.go', line: 1 }] },
  })
  assert.equal(call.result.isError, false, 'disabled is a text result, not an error')
  assert.match(call.result.content[0].text, /Jev disabled/)
  assert.equal(stub.requests.length, 0)
})

test('start --jev-mcp writes a merged config and appends the self-check sentence', async (t) => {
  const root = scratch('jev-mcp-start')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const baseConfig = path.join(root, 'base.json')
  fs.writeFileSync(baseConfig, `${JSON.stringify({ mcpServers: { other: { command: 'node', args: ['other.cjs'] } } })}\n`)

  const start = await run(['start', 'check the diff and report as JSON', '--jev-mcp', '--mcp-config', baseConfig, '--detach', '--json'], env)
  assert.equal(start.status, 0, start.stderr)
  const job = JSON.parse(start.stdout)
  const jobsDir = path.join(root, 'jobs')
  const merged = path.join(jobsDir, `${job.jobId}.mcp.json`)
  assert.equal(fs.existsSync(merged), true, 'the merged config is written in the jobs dir')
  const config = JSON.parse(fs.readFileSync(merged, 'utf8'))
  assert.ok(config.mcpServers.jev, 'the jev server is mounted')
  assert.ok(config.mcpServers.other, 'the --mcp-config servers are kept')
  assert.match(config.mcpServers.jev.args[0], /mcp-jev[\\/]server\.cjs$/)

  const record = JSON.parse(fs.readFileSync(path.join(jobsDir, `${job.jobId}.json`), 'utf8'))
  assert.equal(record.mcpConfig, merged)
  assert.match(record.prompt, /you may call jev_check_claims on the file:line claims you make/)
  assert.match(record.prompt, /jev_check_scope on your diff; fix or drop what they flag/)
})

/** A repo with a base commit and one later commit changing a.txt. */
function makeScopeRepo(root) {
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  const guard = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args) => spawnSync('git', ['-C', repo, '-c', 'user.email=t@e', '-c', 'user.name=T', ...args], { encoding: 'utf8', env: guard })
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD').stdout.trim()
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha changed\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'change a.txt')
  return { repo, base }
}

test('mcp-jev jev_check_scope reuses the review detectors over base..HEAD', async (t) => {
  const root = scratch('mcp-scope')
  const { repo, base } = makeScopeRepo(root)
  const stub = await startStub((parsed) => {
    if (!parsed?.questions?.odd_hunk) return null
    const probabilities = { none: 0.2 }
    let index = 0
    for (const hunkId of Object.keys(parsed.state.hunks)) probabilities[hunkId] = index++ === 0 ? 0.7 : 0.03
    return { payload: { model: 'jev-test', answers: { odd_hunk: { choice: 'h0', probabilities, confidence: 0.9 } }, usage: {} } }
  })
  t.after(() => stub.close())
  const env = { ...baseEnv(root, stub.url), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const session = startMcp(env, repo)
  t.after(() => session.close())

  await session.request('initialize', { protocolVersion: '2024-11-05', clientCapabilities: {} })
  const call = await session.request('tools/call', {
    name: 'jev_check_scope',
    arguments: { work_order: 'Change a.txt and report it as JSON.', repo, base },
  })
  assert.equal(call.result.isError, false, call.result.content[0].text)
  const report = JSON.parse(call.result.content[0].text)
  assert.equal(report.flagged, true)
  assert.ok(report.groups.length >= 1, 'the flagged group is reported')
  assert.ok(report.lookHere.length >= 1, 'the look-here hunks are reported')
  assert.ok(report.lookHere.some((entry) => entry.file === 'a.txt'))
})
