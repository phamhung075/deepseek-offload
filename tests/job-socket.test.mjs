import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { jobSocketPath, SOCKET_PATH_MAX } from '../.agents/skills/deepseek-offload/scripts/lib/job-socket.mjs'

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

/**
 * A project whose job store sits under a path as deep as a 4genthub seat
 * worktree, so `<jobs>/<jobId>.sock` is past the 108-byte sun_path limit.
 */
function longFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-offload-sock-${name}-`))
  let project = path.join(root, '.config', '4genthub', 'rooms', 'aa2-rs', 'wt', 'bevy-dev', 'aa2-rs')
  while (Buffer.byteLength(path.join(project, 'scratch', 'dsh-offload', 'jobs', 'job-20261030-185606-f667.sock')) <= 120) {
    project = path.join(project, 'deeper')
  }
  fs.mkdirSync(project, { recursive: true })
  const stub = path.join(root, 'stub-dsh.cjs')
  fs.writeFileSync(stub, STUB)
  fs.chmodSync(stub, 0o755)
  const runtime = path.join(root, 'run')
  fs.mkdirSync(runtime, { mode: 0o700 })
  return { root, project, stub, runtime, jobs: path.join(project, 'scratch', 'dsh-offload'), log: path.join(root, 'acp.log') }
}

function run(fx, args) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: fx.project,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: fx.root,
      XDG_RUNTIME_DIR: fx.runtime,
      DSH_HOME: path.join(fx.root, 'dsh-home'),
      DSH_BIN: fx.stub,
      DSH_BRIDGE_PROJECT_ROOT: fx.project,
      DSH_OFFLOAD_JOB_DIR: '',
      DEEPSEEK_OFFLOAD_GUARD_DIR: path.join(fx.root, 'guards'),
      DEEPSEEK_MCP_DEFAULT_CWD: fx.project,
      DEEPSEEK_WORKSPACE_ATTACH: '0',
      DEEPSEEK_MCP_CONFIG: '',
      STUB_LOG: fx.log,
    },
  })
}

test('a job started from a deep cwd runs, with its socket in a short private directory', () => {
  const fx = longFixture('run')
  const prompt = path.join(fx.root, 'prompt.md')
  fs.writeFileSync(prompt, 'say hello\n')

  const started = run(fx, ['start', '--prompt-file', prompt, '--cwd', fx.project, '--label', 'deep', '--json'])
  assert.equal(started.status, 0, started.stderr)
  const job = JSON.parse(started.stdout)

  const waited = run(fx, ['wait', job.jobId, '--timeout-ms', '45000', '--json'])
  assert.equal(waited.status, 0, waited.stderr || waited.stdout)
  const outcome = JSON.parse(waited.stdout)
  assert.equal(outcome.state, 'done', outcome.error)
  assert.match(outcome.result, /continued/)

  const record = JSON.parse(fs.readFileSync(path.join(fx.jobs, 'jobs', `${job.jobId}.json`), 'utf8'))
  assert.equal(typeof record.socketPath, 'string', 'the worker records where its socket went')
  assert.ok(Buffer.byteLength(record.socketPath) <= SOCKET_PATH_MAX, record.socketPath)
  assert.equal(path.dirname(record.socketPath), path.join(fx.runtime, 'dsh-offload'))
  assert.equal(fs.existsSync(record.socketPath), false, 'the worker removes its socket when it ends')
})

test('jobSocketPath keeps a short path next to the job record', () => {
  const jobs = '/tmp/p/scratch/dsh-offload/jobs'
  assert.equal(jobSocketPath(jobs, 'job-1'), path.join(jobs, 'job-1.sock'))
})

test('jobSocketPath moves a long path to a private directory, distinct per job store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-offload-sockpath-'))
  const longA = path.join('/x'.repeat(60), 'a', 'jobs')
  const longB = path.join('/x'.repeat(60), 'b', 'jobs')
  const options = { runtimeDir: path.join(root, 'run'), tmpDir: root, uid: process.getuid() }
  const a = jobSocketPath(longA, 'job-20261030-185606-f667', options)
  const b = jobSocketPath(longB, 'job-20261030-185606-f667', options)
  assert.notEqual(a, b)
  assert.equal(path.dirname(a), path.join(root, 'run', 'dsh-offload'))
  assert.ok(Buffer.byteLength(a) <= SOCKET_PATH_MAX)
  assert.equal(fs.statSync(path.dirname(a)).mode & 0o777, 0o700)
})

test('jobSocketPath skips a runtime directory it cannot own and falls back to tmp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-offload-sockpath-'))
  // A file where the directory should be: not usable.
  fs.mkdirSync(path.join(root, 'run'))
  fs.writeFileSync(path.join(root, 'run', 'dsh-offload'), '')
  const p = jobSocketPath(path.join('/x'.repeat(60), 'jobs'), 'job-1', { runtimeDir: path.join(root, 'run'), tmpDir: root, uid: process.getuid() })
  assert.equal(path.dirname(p), path.join(root, `dsh-offload-${process.getuid()}`))
})
