import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))

/**
 * A stand-in for `dsh --profile acp` whose sessions live in one shared
 * registry file, so every child's session/list shows the sessions of every
 * job in the cwd, as the real shared store does. Each prompt answers with the
 * session it ran in and takes a few seconds, so both jobs' sessions are listed
 * while both workers are still discovering.
 */
const STUB = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const crypto = require('node:crypto')
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
const registry = process.env.STUB_REGISTRY
const listed = () => (fs.existsSync(registry) ? fs.readFileSync(registry, 'utf8').trim().split('\\n').filter(Boolean) : [])
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
    if (msg.method === 'session/new') {
      const sessionId = 'session-' + crypto.randomBytes(4).toString('hex')
      fs.appendFileSync(registry, sessionId + '\\n')
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } })
    } else if (msg.method === 'session/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessions: listed().reverse().map((sessionId) => ({ sessionId, cwd: msg.params.cwd })) } })
    } else if (msg.method === 'session/prompt') {
      setTimeout(() => {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ran in ' + msg.params.sessionId } } } })
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      }, 6000)
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
})
`

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-offload-announce-'))
  const project = path.join(root, 'project')
  fs.mkdirSync(project)
  const stub = path.join(root, 'stub-dsh.cjs')
  fs.writeFileSync(stub, STUB)
  fs.chmodSync(stub, 0o755)
  const jobs = path.join(root, 'jobs-root')
  fs.mkdirSync(path.join(jobs, 'jobs'), { recursive: true })
  return { root, project, stub, jobs }
}

function env(fx) {
  return {
    ...process.env,
    HOME: fx.root,
    DSH_HOME: path.join(fx.root, 'dsh-home'),
    DSH_BIN: fx.stub,
    DSH_BRIDGE_PROJECT_ROOT: fx.project,
    DSH_OFFLOAD_JOB_DIR: fx.jobs,
    DSH_OFFLOAD_FORK_OVERLAYS: '0',
    // Let the ambiguous listing fallback run too, so it would claim a wrong id
    // if it still outranked the bridge's announcement.
    DSH_OFFLOAD_LIST_DISCOVERY_GRACE_MS: '0',
    DEEPSEEK_OFFLOAD_GUARD_DIR: path.join(fx.root, 'guards'),
    DEEPSEEK_MCP_DEFAULT_CWD: fx.project,
    DEEPSEEK_WORKSPACE_ATTACH: '0',
    DEEPSEEK_MCP_CONFIG: '',
    STUB_REGISTRY: path.join(fx.root, 'sessions.txt'),
  }
}

/** Run the CLI without blocking the event loop, so two starts overlap. */
function runAsync(fx, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { cwd: fx.project, env: env(fx) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

test('two jobs started together in one cwd each record their own session', async () => {
  const fx = fixture()
  const starts = await Promise.all([1, 2].map((n) => runAsync(fx, ['start', `task ${n}`, '--cwd', fx.project, '--detach', '--json'])))
  const ids = starts.map((out) => {
    assert.equal(out.status, 0, out.stderr)
    return JSON.parse(out.stdout).jobId
  })

  // Read the session ids the workers recorded while the prompts still run.
  const deadline = Date.now() + 30_000
  let midRun
  for (;;) {
    midRun = ids.map((id) => JSON.parse(fs.readFileSync(path.join(fx.jobs, 'jobs', `${id}.json`), 'utf8')).sessionId)
    if (midRun.every((sid) => typeof sid === 'string') || Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  const outcomes = await Promise.all(ids.map((id) => runAsync(fx, ['wait', id, '--timeout-ms', '45000', '--json'])))
  const results = outcomes.map((out) => {
    assert.equal(out.status, 0, out.stderr)
    return JSON.parse(out.stdout)
  })
  for (const [index, outcome] of results.entries()) {
    const ranIn = /ran in (\S+)/.exec(outcome.result)[1]
    assert.equal(outcome.sessionId, ranIn, `job ${index + 1} recorded the session it ran in`)
    assert.equal(midRun[index], ranIn, `job ${index + 1} discovered its own session while running`)
  }
  assert.notEqual(results[0].sessionId, results[1].sessionId)
})
