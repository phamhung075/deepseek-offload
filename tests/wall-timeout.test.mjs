/**
 * `--timeout-ms` bounds a job in wall clock from its start, boot included. The
 * bridge used to count it per prompt, from after its boot, so a 45-minute job ran
 * 54 minutes.
 *
 * Run: node --test tests/wall-timeout.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))
const BOOT_MS = 1_500
const TIMEOUT_MS = 5_000

/**
 * A stand-in for `dsh --profile acp` that takes `BOOT_MS` to answer `initialize`,
 * writes a file into its cwd when prompted and never ends the turn by itself. With
 * `STUB_HONOURS_CANCEL=1` a `session/cancel` ends the turn with a partial answer.
 */
const STUB = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
let buffer = ''
let pendingPrompt = null
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.method === 'session/cancel') {
      if (process.env.STUB_HONOURS_CANCEL === '1' && pendingPrompt !== null) {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'wall-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer' } } } })
        send({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: 'cancelled' } })
        pendingPrompt = null
      }
      continue
    }
    if (msg.id === undefined || msg.id === null) continue
    if (msg.method === 'initialize') {
      setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: {} }), Number(process.env.STUB_BOOT_MS))
    } else if (msg.method === 'session/prompt') {
      fs.writeFileSync(process.env.STUB_PID_FILE, String(process.pid))
      fs.writeFileSync(path.join(process.env.STUB_CWD, 'partial.txt'), 'work in progress\\n')
      pendingPrompt = msg.id
    } else if (msg.method === 'session/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessions: [] } })
    } else if (msg.method === 'session/new') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'wall-session' } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
})
`

function fixture(name, { honoursCancel }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-offload-wall-${name}-`))
  const project = path.join(root, 'project')
  fs.mkdirSync(project)
  const stub = path.join(root, 'stub-dsh.cjs')
  fs.writeFileSync(stub, STUB)
  fs.chmodSync(stub, 0o755)
  const jobs = path.join(root, 'jobs-root')
  fs.mkdirSync(path.join(jobs, 'jobs'), { recursive: true })
  const env = {
    ...process.env,
    HOME: root,
    DSH_HOME: path.join(root, 'dsh-home'),
    DSH_BIN: stub,
    DSH_BRIDGE_PROJECT_ROOT: project,
    DSH_OFFLOAD_JOB_DIR: jobs,
    DSH_OFFLOAD_INDEX: path.join(root, 'index.jsonl'),
    DEEPSEEK_OFFLOAD_GUARD_DIR: path.join(root, 'guards'),
    DEEPSEEK_MCP_DEFAULT_CWD: project,
    DEEPSEEK_WORKSPACE_ATTACH: '0',
    DEEPSEEK_MCP_CONFIG: '',
    STUB_BOOT_MS: String(BOOT_MS),
    STUB_CWD: project,
    STUB_PID_FILE: path.join(root, 'stub.pid'),
    STUB_HONOURS_CANCEL: honoursCancel ? '1' : '0',
  }
  return { root, project, env, jobs }
}

function run(fx, args, timeout = 60_000) {
  return spawnSync(process.execPath, [RUNNER, ...args], { cwd: fx.project, encoding: 'utf8', timeout, env: fx.env })
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Start a job with `--timeout-ms TIMEOUT_MS`, wait for it, and return its record. */
function runToWall(fx) {
  const started = run(fx, ['start', 'a task that never ends', '--timeout-ms', String(TIMEOUT_MS), '--detach', '--no-project-rules', '--json'])
  assert.equal(started.status, 0, started.stderr)
  const { jobId } = JSON.parse(started.stdout)
  const waited = run(fx, ['wait', jobId, '--timeout-ms', String(TIMEOUT_MS * 4), '--json'])
  const job = JSON.parse(fs.readFileSync(path.join(fx.jobs, 'jobs', `${jobId}.json`), 'utf8'))
  return { waited, job }
}

test('a turn that ignores cancel is killed by the wall-clock deadline, boot included', () => {
  const fx = fixture('kill', { honoursCancel: false })
  const { waited, job } = runToWall(fx)
  assert.equal(job.state, 'timed_out', JSON.stringify(job))
  assert.equal(waited.status, 1, 'wait exits 1 for a timed-out job')
  assert.ok(job.finishedAt - job.startedAt <= TIMEOUT_MS, `ran ${job.finishedAt - job.startedAt} ms past a ${TIMEOUT_MS} ms bound`)
  assert.equal(job.stopReason, 'wall_timeout')
  assert.match(job.error, /wall-clock limit/)
  assert.equal(fs.readFileSync(path.join(fx.project, 'partial.txt'), 'utf8'), 'work in progress\n', 'partial work stays in the cwd')
  const pid = Number(fs.readFileSync(fx.env.STUB_PID_FILE, 'utf8'))
  assert.equal(alive(pid), false, 'the ACP child was stopped with the bridge')
})

test('a turn that honours cancel keeps its partial answer and still ends by the deadline', () => {
  const fx = fixture('cancel', { honoursCancel: true })
  const { waited, job } = runToWall(fx)
  assert.equal(job.state, 'timed_out', JSON.stringify(job))
  assert.ok(job.finishedAt - job.startedAt <= TIMEOUT_MS, `ran ${job.finishedAt - job.startedAt} ms past a ${TIMEOUT_MS} ms bound`)
  assert.equal(job.sessionId, 'wall-session')
  assert.match(JSON.parse(waited.stdout).result, /partial answer[\s\S]*wall-clock limit/)
})

test('resume is bounded the same way', () => {
  const fx = fixture('resume', { honoursCancel: false })
  const original = { jobId: 'job-20260101-000000-dead', label: null, state: 'error', prompt: 'x', cwd: fx.project, mcpConfig: null, permission: 'allow', allowGitWrite: false, readOnly: false, timeoutMs: 60_000, sessionId: 'wall-session', startedAt: Date.now() - 60_000, pid: 2 ** 30 }
  fs.writeFileSync(path.join(fx.jobs, 'jobs', `${original.jobId}.json`), JSON.stringify(original))
  const started = run(fx, ['resume', original.jobId, 'go on', '--timeout-ms', String(TIMEOUT_MS), '--no-project-rules', '--json'])
  assert.equal(started.status, 0, started.stderr)
  const { jobId } = JSON.parse(started.stdout)
  run(fx, ['wait', jobId, '--timeout-ms', String(TIMEOUT_MS * 4), '--json'])
  const job = JSON.parse(fs.readFileSync(path.join(fx.jobs, 'jobs', `${jobId}.json`), 'utf8'))
  assert.equal(job.state, 'timed_out', JSON.stringify(job))
  assert.ok(job.finishedAt - job.startedAt <= TIMEOUT_MS, `ran ${job.finishedAt - job.startedAt} ms past a ${TIMEOUT_MS} ms bound`)
})
