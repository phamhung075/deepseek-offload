/**
 * Project rules file tests: `<git toplevel of cwd>/.agents/offload-rules.md`.
 *
 * When the file exists, `start` and `resume` prepend one line naming its
 * absolute path, and the job record keeps the path and the sha256 of the
 * content the run was pointed at. Without the file the prompt is unchanged,
 * byte for byte; `--no-project-rules` leaves it unchanged as well.
 *
 * Run: node --test tests/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))
const RULES = (top) => path.join(top, '.agents', 'offload-rules.md')
const LINE = (file) => `Before anything else, read ${file} in full and follow it; it is this project's contract for every job.`

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

function git(cwd, ...args) {
  const out = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  return out.stdout.trim()
}

/** A git project (optionally with a rules file), job store and stub child. */
function fixture(name, { rules = null, repo = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dsh-offload-rules-${name}-`)))
  const project = path.join(root, 'project')
  fs.mkdirSync(project)
  if (repo) git(project, 'init', '-q')
  if (rules !== null) {
    fs.mkdirSync(path.dirname(RULES(project)), { recursive: true })
    fs.writeFileSync(RULES(project), rules)
  }
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

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')

/** Start a job, wait for it, and return its record and the text the child received. */
function startAndWait(fx, args) {
  const started = run(fx, ['start', ...args, '--detach', '--json'])
  assert.equal(started.status, 0, started.stderr)
  const job = JSON.parse(started.stdout)
  const waited = run(fx, ['wait', job.jobId, '--timeout-ms', '45000', '--json'])
  assert.equal(waited.status, 0, waited.stderr)
  const prompts = fs.readFileSync(fx.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    .filter((entry) => entry.method === 'session/prompt')
  return { job, sent: prompts.at(-1).params.prompt[0].text }
}

test('a rules file at the git top level puts one line naming it before the prompt', () => {
  const fx = fixture('present', { rules: '# rules\nbuild through the slot\n' })
  const sub = path.join(fx.project, 'crates', 'core')
  fs.mkdirSync(sub, { recursive: true })

  const { job, sent } = startAndWait(fx, ['the task', '--cwd', sub])
  const expected = `${LINE(RULES(fx.project))}\n\nthe task`
  assert.equal(sent, expected, 'the child receives the line, a blank line, then the prompt')
  assert.equal(job.prompt, expected)
  assert.deepEqual(job.projectRules, { path: RULES(fx.project), sha256: sha256('# rules\nbuild through the slot\n') })

  const status = run(fx, ['status', job.jobId])
  assert.match(status.stdout, new RegExp(`^rules +${RULES(fx.project)} sha256=${job.projectRules.sha256}$`, 'm'))
  const result = run(fx, ['result', job.jobId])
  assert.match(result.stdout.split('--- result ---')[0], /^rules +\S+offload-rules\.md sha256=[0-9a-f]{64}$/m)
})

test('no rules file: the prompt reaches the child byte for byte', () => {
  for (const repo of [true, false]) {
    const fx = fixture(repo ? 'absent' : 'nogit', { repo })
    const prompt = 'line one\n\n```sh\necho `whoami`\n```'
    const file = path.join(fx.root, 'prompt.md')
    fs.writeFileSync(file, prompt)
    const { job, sent } = startAndWait(fx, ['--prompt-file', file])
    assert.equal(sent, prompt)
    assert.equal(job.prompt, prompt)
    assert.equal(job.projectRules, null)
    assert.match(run(fx, ['status', job.jobId]).stdout, /^rules +none /m)
  }
})

test('--no-project-rules leaves the prompt alone and says so', () => {
  const fx = fixture('optout', { rules: 'rules\n' })
  const { job, sent } = startAndWait(fx, ['the task', '--no-project-rules'])
  assert.equal(sent, 'the task')
  assert.equal(job.projectRules, null)
  assert.equal(job.projectRulesSkipped, true)
  assert.match(run(fx, ['status', job.jobId]).stdout, /^rules +not included \(--no-project-rules\)$/m)
})

test('a linked worktree reads its own copy of the rules file', () => {
  const fx = fixture('worktree', { rules: 'main copy\n' })
  git(fx.project, 'add', '-A')
  git(fx.project, 'commit', '-q', '-m', 'rules')
  const tree = path.join(fx.root, 'linked')
  git(fx.project, 'worktree', 'add', '-q', '-b', 'side', tree)
  fs.writeFileSync(RULES(tree), 'branch copy\n')

  const { job, sent } = startAndWait(fx, ['the task', '--cwd', tree])
  assert.equal(sent, `${LINE(RULES(tree))}\n\nthe task`)
  assert.deepEqual(job.projectRules, { path: RULES(tree), sha256: sha256('branch copy\n') })
})

test('resume injects the line again and records the sha of the current file', () => {
  const fx = fixture('resume', { rules: 'first version\n' })
  const original = {
    jobId: 'job-20260101-000000-dead',
    label: null,
    state: 'running',
    prompt: `${LINE(RULES(fx.project))}\n\noriginal task`,
    projectRules: { path: RULES(fx.project), sha256: sha256('first version\n') },
    projectRulesSkipped: false,
    cwd: fx.project,
    mcpConfig: null,
    permission: 'allow',
    allowGitWrite: false,
    readOnly: false,
    timeoutMs: 60_000,
    sessionId: 'interrupted-session',
    startedAt: Date.now() - 60_000,
    pid: 2 ** 30,
  }
  fs.writeFileSync(path.join(fx.jobs, 'jobs', `${original.jobId}.json`), JSON.stringify(original))
  fs.writeFileSync(RULES(fx.project), 'second version\n')

  const started = run(fx, ['resume', original.jobId, 'skip the docs step', '--json'])
  assert.equal(started.status, 0, started.stderr)
  const job = JSON.parse(started.stdout)
  assert.ok(job.prompt.startsWith(`${LINE(RULES(fx.project))}\n\n`), job.prompt)
  assert.match(job.prompt, /skip the docs step$/)
  assert.deepEqual(job.projectRules, { path: RULES(fx.project), sha256: sha256('second version\n') })
  const waited = run(fx, ['wait', job.jobId, '--timeout-ms', '45000', '--json'])
  assert.equal(waited.status, 0, waited.stderr)
  const sent = fs.readFileSync(fx.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    .find((entry) => entry.method === 'session/prompt').params.prompt[0].text
  assert.equal(sent, job.prompt)
})

test('doctor names the rules file for the cwd, or none', () => {
  const fx = fixture('doctor', { rules: 'rules\n' })
  const found = Object.fromEntries(JSON.parse(run(fx, ['doctor', '--json']).stdout).checks.map((c) => [c.name, c]))
  assert.equal(found['project rules file'].ok, true)
  assert.match(found['project rules file'].detail, new RegExp(`^${RULES(fx.project)} sha256=${sha256('rules\n')}`))

  const bare = path.join(fx.root, 'bare')
  fs.mkdirSync(bare)
  git(bare, 'init', '-q')
  const none = Object.fromEntries(JSON.parse(run(fx, ['doctor', '--cwd', bare, '--json']).stdout).checks.map((c) => [c.name, c]))
  assert.equal(none['project rules file'].ok, true)
  assert.match(none['project rules file'].detail, /^none — no .*offload-rules\.md/)
})
