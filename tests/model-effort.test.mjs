import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))

/**
 * A stand-in for `dsh --profile acp` that advertises the Harness's model and
 * reasoning_effort session options, applies `session/set_config_option` the
 * way packages/acp/acp/src/model-control.ts does, and logs every request and
 * its argv to `STUB_LOG`.
 */
const STUB = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n')
let model = process.env.STUB_MODEL || '["deepseek-official","deepseek-flash"]'
let effort = 'high'
const options = () => [
  { id: 'model', type: 'select', currentValue: model, options: [] },
  { id: 'reasoning_effort', type: 'select', currentValue: effort, options: [] },
]
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
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    } else if (msg.method === 'session/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessions: [] } })
    } else if (msg.method === 'session/new') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'fresh-session', configOptions: options() } })
    } else if (msg.method === 'session/set_config_option') {
      if (msg.params.configId === 'model') { model = msg.params.value; effort = 'high' }
      else effort = msg.params.value
      send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: options() } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
})
`

function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-offload-model-${name}-`))
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
      DSH_OFFLOAD_FORK_OVERLAYS: '0',
      DEEPSEEK_OFFLOAD_GUARD_DIR: path.join(fx.root, 'guards'),
      DEEPSEEK_MCP_DEFAULT_CWD: fx.project,
      DEEPSEEK_WORKSPACE_ATTACH: '0',
      DEEPSEEK_MCP_CONFIG: '',
      STUB_LOG: fx.log,
      ...(fx.env ?? {}),
    },
  })
}

function startAndWait(fx, flags) {
  const started = run(fx, ['start', 'tiny task', '--cwd', fx.project, '--detach', '--json', ...flags])
  assert.equal(started.status, 0, started.stderr)
  const job = JSON.parse(started.stdout)
  const waited = run(fx, ['wait', job.jobId, '--timeout-ms', '45000', '--json'])
  assert.equal(waited.status, 0, waited.stderr)
  const entries = fs.readFileSync(fx.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  return { job, outcome: JSON.parse(waited.stdout), entries }
}

test('--model and --effort are recorded and set on the session before the first prompt', () => {
  const fx = fixture('flash-max')
  const { job, outcome, entries } = startAndWait(fx, ['--model', 'deepseek-flash', '--effort', 'max'])
  assert.equal(job.model, 'deepseek-flash')
  assert.equal(job.effort, 'max')
  assert.equal(outcome.state, 'done')
  assert.equal(outcome.modelSelection, 'deepseek-official/deepseek-flash effort=max (requested model=deepseek-flash effort=max)')

  const methods = entries.filter((entry) => entry.method).map((entry) => entry.method)
  const sets = entries.filter((entry) => entry.method === 'session/set_config_option').map((entry) => entry.params)
  assert.deepEqual(sets, [
    { sessionId: 'fresh-session', configId: 'model', value: '["deepseek-official","deepseek-flash"]' },
    { sessionId: 'fresh-session', configId: 'reasoning_effort', value: 'max' },
  ], 'model first, since a model change resets the effort')
  assert.ok(methods.lastIndexOf('session/set_config_option') < methods.indexOf('session/prompt'))

  const argvLines = entries.filter((entry) => entry.argv)
  const agent = argvLines.find((entry) => entry.argv.some((arg) => /offload-models-/.test(arg)))
  assert.ok(agent, 'the agent child got the model catalog overlay')
  const overlayPath = agent.argv.find((arg) => /offload-models-/.test(arg))
  assert.equal(agent.argv[agent.argv.indexOf(overlayPath) - 1], '--patch')
  const overlay = fs.readFileSync(overlayPath, 'utf8')
  assert.doesNotMatch(overlay, /pro/i, 'the catalog overlay never declares a pro model')
  assert.match(overlay, /- id: deepseek-flash\n\s+name: DeepSeek-V4.1-Flash\n\s+inputModalities: \['text', 'image'\]/)

  const status = run(fx, ['status', job.jobId])
  assert.match(status.stdout, /^model {5}deepseek-flash {2}effort max$/m)
  assert.match(status.stdout, /^applied {3}deepseek-official\/deepseek-flash effort=max/m)
})

test('--effort none turns thinking off and keeps the profile model', () => {
  const fx = fixture('none')
  const { outcome, entries } = startAndWait(fx, ['--effort', 'none'])
  assert.equal(outcome.model, null)
  assert.equal(outcome.effort, 'none')
  const sets = entries.filter((entry) => entry.method === 'session/set_config_option').map((entry) => entry.params)
  assert.deepEqual(sets, [{ sessionId: 'fresh-session', configId: 'reasoning_effort', value: 'off' }])
  assert.equal(entries.some((entry) => entry.argv && entry.argv.some((arg) => /offload-models-/.test(arg))), false,
    'no catalog overlay without a model switch')
  assert.match(outcome.modelSelection, /^deepseek-official\/deepseek-flash effort=off \(requested effort=off\)$/)
})

test('without --model and --effort the session keeps the profile default', () => {
  const fx = fixture('default')
  const { outcome, entries } = startAndWait(fx, [])
  assert.equal(outcome.model, null)
  assert.equal(outcome.effort, null)
  assert.equal(entries.some((entry) => entry.method === 'session/set_config_option'), false)
  assert.equal(outcome.modelSelection, 'deepseek-official/deepseek-flash effort=high (profile default)')
  const status = run(fx, ['status', outcome.jobId])
  assert.match(status.stdout, /^model {5}profile default {2}effort default \(high\)$/m)
})

for (const [flag, value] of [['--model', 'deepseek-chat'], ['--effort', 'medium'], ['--effort', 'off']]) {
  test(`an unknown ${flag} ${value} fails before a job is recorded`, () => {
    const fx = fixture('bad')
    const out = run(fx, ['start', 'tiny task', '--cwd', fx.project, flag, value])
    assert.equal(out.status, 1)
    assert.match(out.stderr, new RegExp(`${flag} must be one of`))
    assert.deepEqual(fs.readdirSync(path.join(fx.jobs, 'jobs')), [])
  })
}

// Owner ruling 2026-11-07: never use deepseek-v4-pro, blocked in code.
for (const id of ['deepseek-v4-pro', 'DeepSeek-V4-Pro', 'deepseek-official/deepseek-v4-pro', 'deepseek-pro']) {
  test(`start --model ${id} is refused before a job is recorded, naming the ruling`, () => {
    const fx = fixture('pro')
    const out = run(fx, ['start', 'tiny task', '--cwd', fx.project, '--model', id])
    assert.equal(out.status, 1)
    assert.match(out.stderr, /owner ruling 2026-11-07/)
    assert.match(out.stderr, /--model deepseek-flash/)
    assert.deepEqual(fs.readdirSync(path.join(fx.jobs, 'jobs')), [])
    assert.equal(fs.existsSync(fx.log), false, 'no Harness was started')
  })
}

test('resume of a job recorded on v4-pro runs on deepseek-flash and says so; an explicit pro resume is refused', () => {
  const fx = fixture('pro-resume')
  const { job } = startAndWait(fx, [])
  const file = path.join(fx.jobs, 'jobs', `${job.jobId}.json`)
  // A record written before the block.
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), model: 'deepseek-v4-pro' }))

  const refused = run(fx, ['resume', job.jobId, '--model', 'deepseek-v4-pro'])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /owner ruling 2026-11-07/)

  const resumed = run(fx, ['resume', job.jobId, '--json'])
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.match(resumed.stderr, /resume runs on deepseek-flash/)
  const next = JSON.parse(resumed.stdout)
  assert.equal(next.model, 'deepseek-flash')
  const waited = run(fx, ['wait', next.jobId, '--timeout-ms', '45000', '--json'])
  assert.equal(waited.status, 0, waited.stderr)
  assert.match(JSON.parse(waited.stdout).modelSelection, /^deepseek-official\/deepseek-flash /)
})

test('the bridge moves a session that selects a pro model onto deepseek-flash before the first prompt', () => {
  const fx = fixture('pro-pin')
  fx.env = { STUB_MODEL: '["deepseek-official","deepseek-v4-pro"]' }
  const { outcome, entries } = startAndWait(fx, [])
  assert.equal(outcome.state, 'done')
  const sets = entries.filter((entry) => entry.method === 'session/set_config_option').map((entry) => entry.params)
  assert.deepEqual(sets, [{ sessionId: 'fresh-session', configId: 'model', value: '["deepseek-official","deepseek-flash"]' }])
  assert.match(outcome.modelSelection, /^deepseek-official\/deepseek-flash /)
})

test('doctor reports the pro model block', () => {
  const fx = fixture('doctor')
  const out = run(fx, ['doctor', '--json'])
  const checks = JSON.parse(out.stdout).checks ?? JSON.parse(out.stdout)
  const block = (Array.isArray(checks) ? checks : []).find((check) => check.name === 'pro model block')
  assert.ok(block, out.stdout)
  assert.equal(block.ok, true, block.detail)
  assert.match(block.detail, /deepseek-v4-pro and every pro id refused/)
})
