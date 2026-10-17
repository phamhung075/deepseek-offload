import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))

/**
 * A stand-in for `dsh --profile acp` that appends every ACP request it
 * receives to `STUB_LOG` and answers just enough for one agent turn.
 */
const STUB = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined || msg.id === null) continue
    fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n')
    if (msg.method === 'session/prompt') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'continued' } } } })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    } else if (msg.method === 'session/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessions: [] } })
    } else if (msg.method === 'session/new') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'fresh-session' } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
})
`

/** A project directory, job store and stub child for one test. */
function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-offload-resume-${name}-`))
  const project = path.join(root, 'project')
  fs.mkdirSync(project)
  const stub = path.join(root, 'stub-dsh.cjs')
  fs.writeFileSync(stub, STUB)
  fs.chmodSync(stub, 0o755)
  const jobs = path.join(root, 'jobs-root')
  fs.mkdirSync(path.join(jobs, 'jobs'), { recursive: true })
  return { root, project, stub, jobs, log: path.join(root, 'acp.log') }
}

function run(fx, args) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: fx.project,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: fx.root,
      DSH_HOME: path.join(fx.root, 'dsh-home'),
      DSH_BIN: fx.stub,
      DSH_BRIDGE_PROJECT_ROOT: fx.project,
      DSH_OFFLOAD_JOB_DIR: fx.jobs,
      DEEPSEEK_OFFLOAD_GUARD_DIR: path.join(fx.root, 'guards'),
      DEEPSEEK_MCP_DEFAULT_CWD: fx.project,
      DEEPSEEK_WORKSPACE_ATTACH: '0',
      DEEPSEEK_MCP_CONFIG: '',
      STUB_LOG: fx.log,
    },
  })
}

/** Write a job record as a worker would leave it after dying mid-run. */
function interruptedJob(fx, overrides = {}) {
  const job = {
    jobId: 'job-20260101-000000-dead',
    label: 'refactor',
    state: 'running',
    prompt: 'original task',
    cwd: fx.project,
    mcpConfig: null,
    permission: 'allow',
    allowGitWrite: false,
    readOnly: true,
    timeoutMs: 60_000,
    sessionId: 'interrupted-session',
    startedAt: Date.now() - 60_000,
    // A pid far above any real pid_max: the worker is gone.
    pid: 2 ** 30,
    ...overrides,
  }
  fs.writeFileSync(path.join(fx.jobs, 'jobs', `${job.jobId}.json`), JSON.stringify(job))
  return job
}

function readJobFile(fx, jobId) {
  return JSON.parse(fs.readFileSync(path.join(fx.jobs, 'jobs', `${jobId}.json`), 'utf8'))
}

test('resume continues the interrupted session through session/resume in a new job', () => {
  const fx = fixture('ok')
  const original = interruptedJob(fx)

  const started = run(fx, ['resume', original.jobId, 'skip the docs step', '--json'])
  assert.equal(started.status, 0, started.stderr)
  const job = JSON.parse(started.stdout)
  assert.equal(job.resumeOf, original.jobId)
  assert.equal(job.sessionId, 'interrupted-session')
  assert.equal(job.cwd, fx.project)
  assert.equal(job.readOnly, true, 'the original file policy carries over')
  assert.match(job.prompt, /skip the docs step/)

  const waited = run(fx, ['wait', job.jobId, '--timeout-ms', '45000', '--json'])
  assert.equal(waited.status, 0, waited.stderr)
  const outcome = JSON.parse(waited.stdout)
  assert.equal(outcome.state, 'done')
  assert.equal(outcome.sessionId, 'interrupted-session')
  assert.match(outcome.result, /continued/)

  const methods = fs.readFileSync(fx.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const resume = methods.find((entry) => entry.method === 'session/resume')
  assert.deepEqual(resume.params, { sessionId: 'interrupted-session', cwd: fx.project, mcpServers: [] })
  assert.equal(methods.some((entry) => entry.method === 'session/new'), false)
  assert.equal(methods.find((entry) => entry.method === 'session/prompt').params.sessionId, 'interrupted-session')

  const after = readJobFile(fx, original.jobId)
  assert.equal(after.state, 'error', 'the dead worker was reconciled')
  assert.equal(after.resumedBy, job.jobId)
})

test('resume refuses a job that never recorded a session id', () => {
  const fx = fixture('nosession')
  const original = interruptedJob(fx, { sessionId: null })
  const out = run(fx, ['resume', original.jobId])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /never recorded a session id/)
  assert.match(out.stderr, /resume --session <id> --cwd /)
})

test('resume refuses a job whose worker is still alive', () => {
  const fx = fixture('alive')
  const original = interruptedJob(fx, { pid: process.pid })
  const out = run(fx, ['resume', original.jobId])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /still running/)
})

test('list ignores sidecar files stored next to a job record', () => {
  const fx = fixture('sidecar')
  const job = interruptedJob(fx)
  fs.writeFileSync(path.join(fx.jobs, 'jobs', `${job.jobId}.extra-sidecar.json`), '{}')

  const out = run(fx, ['list'])
  assert.equal(out.status, 0, out.stderr)
  const lines = out.stdout.trim().split('\n')
  assert.equal(lines.length, 2, 'a header plus exactly one job row')
  assert.match(out.stdout, new RegExp(job.jobId))
  assert.equal(out.stdout.includes('extra-sidecar'), false)
})

test('doctor reports resume support from the bridge probe and flags a stale project bridge', () => {
  const fx = fixture('doctor')
  // The stub answers ACP initialize without capabilities, like a Harness that predates resume.
  const bridge = path.join(fx.project, '.agents', 'mcp-deepseek', 'server.cjs')
  fs.mkdirSync(path.dirname(bridge), { recursive: true })
  fs.writeFileSync(bridge, '// an older bridge copy\n')

  const out = run(fx, ['doctor', '--json'])
  const checks = Object.fromEntries(JSON.parse(out.stdout).checks.map((check) => [check.name, check]))
  assert.equal(checks['bridge supports resume'].ok, true)
  assert.equal(checks['dsh acp session/resume'].ok, false)
  assert.match(checks['dsh acp session/resume'].detail, /does not advertise session\/resume/)
  assert.equal(checks['project entries current'].ok, false)
  assert.match(checks['project entries current'].detail, /\.agents\/mcp-deepseek\/server\.cjs/)
})
