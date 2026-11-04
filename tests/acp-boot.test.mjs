import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { triageJob } from '../.agents/skills/deepseek-offload/scripts/lib/triage.mjs'

const BRIDGE = fileURLToPath(new URL('../.agents/mcp-deepseek/server.cjs', import.meta.url))
const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))

/**
 * A stand-in for `dsh --profile acp` whose boot is slow on demand. Each spawn logs
 * one line; the first `STUB_SILENT_BOOTS` spawns never answer `initialize`, like a
 * boot starved of disk. `STUB_EXIT=<code>` exits at once, like a broken profile.
 */
const STUB = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
fs.appendFileSync(process.env.STUB_BOOTS, 'boot\\n')
if (process.env.STUB_EXIT) process.exit(Number(process.env.STUB_EXIT))
const boot = fs.readFileSync(process.env.STUB_BOOTS, 'utf8').trim().split('\\n').length
const silent = boot <= Number(process.env.STUB_SILENT_BOOTS || 0)
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
    if (msg.id === undefined || msg.id === null || silent) continue
    fs.appendFileSync(process.env.STUB_REQUESTS, msg.method + '\\n')
    if (msg.method === 'session/prompt') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'continued' } } } })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    } else if (msg.method === 'session/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessions: [] } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
})
`

/** A project directory, job store and stub child for one test. */
function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-acp-boot-${name}-`))
  const project = path.join(root, 'project')
  fs.mkdirSync(project)
  const stub = path.join(root, 'stub-dsh.cjs')
  fs.writeFileSync(stub, STUB)
  fs.chmodSync(stub, 0o755)
  const jobs = path.join(root, 'jobs-root')
  fs.mkdirSync(path.join(jobs, 'jobs'), { recursive: true })
  return { root, project, stub, jobs, boots: path.join(root, 'boots.log'), requests: path.join(root, 'requests.log') }
}

/** The environment of a bridge or runner pointed at the fixture's stub. */
function environment(fx, extra) {
  return {
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
    DEEPSEEK_MCP_INIT_TIMEOUT_MS: '400',
    DEEPSEEK_MCP_INIT_ATTEMPTS: '3',
    STUB_BOOTS: fx.boots,
    STUB_REQUESTS: fx.requests,
    ...extra,
  }
}

/** Run the bridge's `--probe`, which boots the child and starts no session. */
function probe(fx, extra = {}) {
  const out = spawnSync(process.execPath, [BRIDGE, '--probe'], {
    cwd: fx.project, encoding: 'utf8', timeout: 60_000, env: environment(fx, extra),
  })
  assert.equal(out.status, 0, out.stderr)
  return { report: JSON.parse(out.stdout.trim().split('\n').pop()), stderr: out.stderr }
}

const boots = (fx) => fs.readFileSync(fx.boots, 'utf8').trim().split('\n').length

test('a boot that times out at initialize is repeated and then succeeds', () => {
  const fx = fixture('retry')
  const { report, stderr } = probe(fx, { STUB_SILENT_BOOTS: '2' })
  assert.equal(report.acpError, null)
  assert.notEqual(report.acp, null)
  assert.equal(boots(fx), 3)
  assert.match(stderr, /dsh boot attempt 1 of 3/)
})

test('a warm boot spawns exactly one child', () => {
  const fx = fixture('warm')
  const { report } = probe(fx)
  assert.equal(report.acpError, null)
  assert.equal(boots(fx), 1)
})

test('the attempts are bounded and the last error names them', () => {
  const fx = fixture('bounded')
  const { report } = probe(fx, { STUB_SILENT_BOOTS: '99' })
  assert.match(report.acpError, /timed out after 400ms: initialize \(3 of 3 boot attempts\)/)
  assert.equal(boots(fx), 3)
})

test('a child that exits during boot fails at once: a broken profile is not retried', () => {
  const fx = fixture('broken')
  const { report } = probe(fx, { STUB_EXIT: '3' })
  assert.match(report.acpError, /exited with code 3/)
  assert.equal(boots(fx), 1)
})

test('one attempt turns the retry off, as doctor asks', () => {
  const fx = fixture('single')
  const { report } = probe(fx, { STUB_SILENT_BOOTS: '99', DEEPSEEK_MCP_INIT_ATTEMPTS: '1' })
  assert.match(report.acpError, /initialize/)
  assert.equal(boots(fx), 1)
})

test('resume survives a starved boot: the session resumes once and the turn runs once', () => {
  const fx = fixture('resume')
  const original = {
    jobId: 'job-20260101-000000-dead',
    label: 'refactor',
    state: 'running',
    prompt: 'original task',
    cwd: fx.project,
    mcpConfig: null,
    permission: 'allow',
    allowGitWrite: false,
    readOnly: false,
    timeoutMs: 60_000,
    sessionId: 'interrupted-session',
    startedAt: Date.now() - 60_000,
    pid: 2 ** 30, // far above any real pid_max: the worker is gone
  }
  fs.writeFileSync(path.join(fx.jobs, 'jobs', `${original.jobId}.json`), JSON.stringify(original))
  const run = (args) => spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: fx.project, encoding: 'utf8', timeout: 60_000, env: environment(fx, { STUB_SILENT_BOOTS: '1' }),
  })

  const started = run(['resume', original.jobId, 'carry on', '--json'])
  assert.equal(started.status, 0, started.stderr)
  const job = JSON.parse(started.stdout)
  const waited = run(['wait', job.jobId, '--timeout-ms', '45000', '--json'])
  assert.equal(waited.status, 0, waited.stderr)
  const outcome = JSON.parse(waited.stdout)
  assert.equal(outcome.state, 'done', outcome.error)
  assert.match(outcome.result, /continued/)

  const requests = fs.readFileSync(fx.requests, 'utf8').trim().split('\n')
  assert.equal(requests.filter((method) => method === 'session/resume').length, 1)
  assert.equal(requests.filter((method) => method === 'session/prompt').length, 1)
})

test('triage tells a failed boot from a turn that ran out of time', () => {
  const error = 'ACP request timed out after 120000ms: initialize (3 of 3 boot attempts)'
  const withSession = triageJob('job-a', { state: 'error', error, sessionId: 's' })
  assert.equal(withSession.kind, 'boot')
  assert.match(withSession.advice, /resume job-a/)
  assert.doesNotMatch(withSession.advice, /--timeout-ms/)
  assert.match(triageJob('job-b', { state: 'error', error, sessionId: null }).advice, /Start the job again/)

  const turn = triageJob('job-c', { state: 'error', error: 'ACP request timed out after 900000ms: session/prompt', timeoutMs: 900_000 })
  assert.equal(turn.kind, 'timeout')
  assert.match(turn.advice, /--timeout-ms 1800000/)
})
