/**
 * Automatic Jev pre-screen: `start --review-repo` records the clone and start
 * commit, the worker reviews the diff when the job settles, and `result` /
 * `wait` print the stored block.
 *
 * The ACP stub makes a real commit in a temp repo, and every test points
 * `TYPESAFE_API_URL` at a local HTTP stub — the real API is never called. The
 * runner is spawned asynchronously (never `spawnSync`): the TypeSafe stub lives
 * in this process, so blocking this event loop would deadlock the child's HTTP
 * call.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderJevBlock } from '../.agents/skills/deepseek-offload/scripts/jev/auto.mjs'
import { jevFreeEnv } from './helpers/jev-env.mjs'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))
const SECRET_KEY = 'sk-test-SECRET-KEY-jev-auto'

/**
 * A stand-in for `dsh --profile acp` that, on the prompt turn, writes
 * `hello.txt` in `STUB_COMMIT_DIR` (falling back to the session cwd) and
 * commits it. The commit dir is separate from the session cwd so the job's
 * cwd is not the review repo — the self-checkout guard then leaves
 * `reviewScope` at `all`. It overrides `GIT_CONFIG_GLOBAL` for its own git
 * calls so an ambient guard cannot leak in.
 */
const STUB = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
let buffer = ''
let cwd = null
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {
  encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
})
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
      const target = process.env.STUB_COMMIT_DIR || cwd
      if (target) {
        fs.writeFileSync(path.join(target, 'hello.txt'), 'hello\\n')
        git(target, 'add', '-A')
        git(target, '-c', 'user.email=stub@example.com', '-c', 'user.name=Stub', 'commit', '-q', '-m', 'add hello')
      }
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    } else if (msg.method === 'session/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessions: [] } })
    } else if (msg.method === 'session/new') {
      if (msg.params && msg.params.cwd) cwd = msg.params.cwd
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'fresh-session' } })
    } else if (msg.method === 'session/resume') {
      if (msg.params && msg.params.cwd) cwd = msg.params.cwd
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
})
`

/** A scratch root, DSH stub and job store for one test. */
function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-jev-auto-${name}-`))
  const stub = path.join(root, 'stub-dsh.cjs')
  fs.writeFileSync(stub, STUB)
  fs.chmodSync(stub, 0o755)
  const jobRoot = path.join(root, 'jobs-root')
  fs.mkdirSync(path.join(jobRoot, 'jobs'), { recursive: true })
  return { root, stub, jobRoot, log: path.join(root, 'acp.log') }
}

/** Start a stub System One server; `handler(parsed, count)` may override the answer. */
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

/** A clean answer set: every noul yes, P(none) high. */
function answerFor(parsed) {
  const questions = parsed?.questions ?? {}
  const answers = {}
  if (questions.odd_hunk) {
    const probabilities = { none: 0.9 }
    for (const id of Object.keys(parsed?.state?.hunks ?? {})) probabilities[id] = 0.05
    answers.odd_hunk = { choice: 'none', probabilities, confidence: 0.9 }
  }
  for (const id of ['in_scope', 'single_outcome', 'self_contained', 'write_policy_stated', 'is_investigation']) {
    if (questions[id]) answers[id] = { noul: 0.9 }
  }
  if (questions.unrequested) answers.unrequested = { noul: 0.1 }
  return { model: 'jev-test', answers, usage: {} }
}

/** The environment the runner and its worker inherit. */
function baseEnv(fx, url, { key = SECRET_KEY } = {}) {
  const env = jevFreeEnv()
  if (key !== null) env.TYPESAFE_API_KEY = key
  env.TYPESAFE_API_URL = url
  env.DSH_OFFLOAD_JOB_DIR = fx.jobRoot
  env.DSH_HOME = path.join(fx.root, 'dsh-home')
  env.DSH_BRIDGE_PROJECT_ROOT = fx.root
  env.DSH_BIN = fx.stub
  env.DEEPSEEK_MCP_DEFAULT_CWD = fx.root
  env.DEEPSEEK_OFFLOAD_GUARD_DIR = path.join(fx.root, 'guards')
  env.DEEPSEEK_WORKSPACE_ATTACH = '0'
  env.DEEPSEEK_MCP_CONFIG = ''
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.STUB_LOG = fx.log
  return env
}

/** Run the runner without blocking this process's event loop (the stub lives here). */
function run(args, env, cwd) {
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

function makeRepo(root) {
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD').stdout.trim()
  return { repo, base }
}

/** A repo with one extra commit, for the on-demand result test. */
function makeRepoWithCommit(root) {
  const { repo, base } = makeRepo(root)
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  fs.writeFileSync(path.join(repo, 'hello.txt'), 'hello\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'add hello')
  return { repo, base }
}

function writeJob(fx, record) {
  fs.writeFileSync(path.join(fx.jobRoot, 'jobs', `${record.jobId}.json`), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

function readJob(fx, jobId) {
  return JSON.parse(fs.readFileSync(path.join(fx.jobRoot, 'jobs', `${jobId}.json`), 'utf8'))
}

/** Start a committing job in `repo` and wait for it; returns `{jobId, started, waited}`. */
async function runJobToCompletion(fx, env, repo, extra = []) {
  // The session cwd is fx.root (not a git work tree) and the stub commits in
  // `repo`, so the review repo is not the job's own checkout: reviewScope 'all'.
  env.STUB_COMMIT_DIR = repo
  const started = await run([
    'start', 'add hello.txt and commit it', '--cwd', fx.root, '--review-repo', repo,
    '--allow-git-write', '--detach', '--json', ...extra,
  ], env, fx.root)
  assert.equal(started.status, 0, started.stderr)
  const jobId = JSON.parse(started.stdout).jobId
  const waited = await run(['wait', jobId, '--timeout-ms', '120000'], env, fx.root)
  return { jobId, started, waited }
}

test('start --review-repo records the toplevel and the start commit', async (t) => {
  const fx = fixture('record')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(fx, stub.url)
  const { repo, base } = makeRepo(fx.root)
  const sub = path.join(repo, 'sub')
  fs.mkdirSync(sub)

  const started = await run(['start', 'do a thing', '--cwd', repo, '--review-repo', sub, '--detach', '--json'], env, fx.root)
  assert.equal(started.status, 0, started.stderr)
  const job = JSON.parse(started.stdout)
  assert.equal(job.reviewRepo, repo, 'the work-tree root is stored, not the subdirectory')
  assert.equal(job.reviewBase, base, 'the base is HEAD at start time')
  await run(['cancel', job.jobId], env, fx.root)
})

test('a non-repo --review-repo warns once and starts without auto-review', async (t) => {
  const fx = fixture('nonrepo')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(fx, stub.url)
  const notRepo = path.join(fx.root, 'not-a-repo')
  fs.mkdirSync(notRepo)

  const started = await run(['start', 'do a thing', '--cwd', fx.root, '--review-repo', notRepo, '--detach', '--json'], env, fx.root)
  assert.equal(started.status, 0, started.stderr)
  assert.match(started.stderr, /not a git work tree/)
  const job = JSON.parse(started.stdout)
  assert.equal(job.reviewRepo, null)
  assert.equal(job.reviewBase, null)
  await run(['cancel', job.jobId], env, fx.root)
})

test('DSH_OFFLOAD_REVIEW_REPO acts as --review-repo, and --no-jev-review wins', async (t) => {
  const fx = fixture('env')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(fx, stub.url)
  const { repo, base } = makeRepo(fx.root)
  env.DSH_OFFLOAD_REVIEW_REPO = repo

  const fromEnv = await run(['start', 'do a thing', '--cwd', repo, '--detach', '--json'], env, fx.root)
  assert.equal(fromEnv.status, 0, fromEnv.stderr)
  const envJob = JSON.parse(fromEnv.stdout)
  assert.equal(envJob.reviewRepo, repo)
  assert.equal(envJob.reviewBase, base)
  await run(['cancel', envJob.jobId], env, fx.root)

  const suppressed = await run(['start', 'do a thing', '--cwd', repo, '--no-jev-review', '--detach', '--json'], env, fx.root)
  assert.equal(suppressed.status, 0, suppressed.stderr)
  const suppressedJob = JSON.parse(suppressed.stdout)
  assert.equal(suppressedJob.reviewRepo, null)
  assert.equal(suppressedJob.reviewBase, null)
  await run(['cancel', suppressedJob.jobId], env, fx.root)
})

test('a flagged worker commit is recorded and printed by result/wait; --jev-exit exits 3', async (t) => {
  const fx = fixture('flagged')
  const { repo, base } = makeRepo(fx.root)
  const stub = await startStub((parsed) => {
    if (!parsed?.questions?.odd_hunk) return null
    const probabilities = { none: 0.2 }
    let index = 0
    for (const id of Object.keys(parsed.state.hunks)) probabilities[id] = index++ === 0 ? 0.7 : 0.03
    return { payload: { model: 'jev-test', answers: { odd_hunk: { choice: 'h0', probabilities, confidence: 0.9 } }, usage: {} } }
  })
  t.after(() => stub.close())
  const env = baseEnv(fx, stub.url)

  const { jobId, waited } = await runJobToCompletion(fx, env, repo)
  assert.equal(waited.status, 0, waited.stderr)
  const job = readJob(fx, jobId)
  assert.equal(job.state, 'done')
  assert.equal(job.jevReview.state, 'flagged')
  assert.equal(job.jevReview.groups, 1)
  assert.equal(job.jevReview.flaggedGroups, 1)
  assert.equal(job.reviewRepo, repo)
  assert.equal(job.reviewBase, base)
  assert.match(waited.stdout, /--- jev review \(pre-screen/)
  assert.match(waited.stdout, /flagged/)
  assert.match(waited.stdout, new RegExp(`${jobId}\\.jev-review\\.json`))
  assert.match(waited.stdout, /look here:/)

  const result = await run(['result', jobId], env, fx.root)
  assert.equal(result.status, 0, `result exit is unchanged: ${result.stderr}`)
  assert.match(result.stdout, /--- jev review \(pre-screen/)

  const jevExit = await run(['result', jobId, '--jev-exit'], env, fx.root)
  assert.equal(jevExit.status, 3, jevExit.stderr)
})

test('a clean worker commit records state clean and shows a clean block', async (t) => {
  const fx = fixture('clean')
  const { repo } = makeRepo(fx.root)
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(fx, stub.url)

  const { jobId, waited } = await runJobToCompletion(fx, env, repo)
  assert.equal(waited.status, 0, waited.stderr)
  const job = readJob(fx, jobId)
  assert.equal(job.jevReview.state, 'clean')
  assert.equal(job.jevReview.flaggedGroups, 0)
  assert.match(waited.stdout, /--- jev review \(pre-screen/)
  assert.match(waited.stdout, /clean/)
  assert.match(waited.stdout, /look here \(none\)/)
})

test('the look-here list prints the header then one entry per line', () => {
  const fx = fixture('lookhere-lines')
  const jobId = 'job-lookhere'
  const report = {
    flagged: true,
    rules: { findings: [] },
    groups: [],
    lookHere: [
      { inScope: 0.031, file: 'a.mjs', range: '@@ -1,2 +1,3 @@', reason: 'lowest in_scope in a flagged group' },
      { inScope: 0.12, file: 'b.mjs', range: '@@ -9,1 +9,2 @@', reason: 'large hunk (7 changed lines) below 0.3' },
    ],
  }
  fs.writeFileSync(path.join(fx.jobRoot, 'jobs', `${jobId}.jev-review.json`), JSON.stringify(report))
  const block = renderJevBlock({ state: 'flagged' }, { jobsDir: path.join(fx.jobRoot, 'jobs'), jobId })
  const lines = block.split('\n')
  assert.equal(lines.filter((line) => line === 'look here:').length, 1, block)
  assert.ok(lines.includes('  0.031  a.mjs @@ -1,2 +1,3 @@  (lowest in_scope in a flagged group)'), block)
  assert.ok(lines.includes('  0.120  b.mjs @@ -9,1 +9,2 @@  (large hunk (7 changed lines) below 0.3)'), block)
  assert.ok(!lines.some((line) => /^look here: /.test(line)), 'the entries are not joined onto the header line')
})

test('no key: state disabled, the block says so, and the stub is never called', async (t) => {
  const fx = fixture('nokey')
  const { repo } = makeRepo(fx.root)
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(fx, stub.url, { key: null })

  const { jobId, waited } = await runJobToCompletion(fx, env, repo)
  assert.equal(waited.status, 0, waited.stderr)
  const job = readJob(fx, jobId)
  assert.equal(job.jevReview.state, 'disabled')
  assert.match(waited.stdout, /jev review: disabled — set TYPESAFE_API_KEY/)

  const result = await run(['result', jobId], env, fx.root)
  assert.match(result.stdout, /jev review: disabled — set TYPESAFE_API_KEY/)
  assert.equal(stub.requests.length, 0, 'a disabled review makes no request')
})

test('resume copies reviewRepo and reviewBase from the resumed job', async (t) => {
  const fx = fixture('resume')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(fx, stub.url)
  const { repo, base } = makeRepo(fx.root)
  writeJob(fx, {
    jobId: 'job-interrupted',
    state: 'running',
    prompt: 'original task',
    cwd: repo,
    permission: 'allow',
    allowGitWrite: true,
    readOnly: false,
    sessionId: 'interrupted-session',
    reviewRepo: repo,
    reviewBase: base,
    startedAt: Date.now() - 60_000,
    pid: 2 ** 30,
  })

  const resumed = await run(['resume', 'job-interrupted', '--json'], env, fx.root)
  assert.equal(resumed.status, 0, resumed.stderr)
  const job = JSON.parse(resumed.stdout)
  assert.equal(job.reviewRepo, repo)
  assert.equal(job.reviewBase, base)
  await run(['cancel', job.jobId], env, fx.root)
})

test('a settled job with no jevReview is reviewed once on demand, not twice', async (t) => {
  const fx = fixture('ondemand')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(fx, stub.url)
  const { repo, base } = makeRepoWithCommit(fx.root)
  writeJob(fx, {
    jobId: 'job-settled',
    state: 'done',
    prompt: 'add hello.txt and commit it',
    cwd: repo,
    reviewRepo: repo,
    reviewBase: base,
    sessionId: 'settled-session',
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now() - 30_000,
  })

  const before = stub.requests.length
  const first = await run(['result', 'job-settled'], env, fx.root)
  assert.equal(first.status, 0, first.stderr)
  const afterFirst = stub.requests.length
  assert.ok(afterFirst > before, 'the on-demand result ran the review')
  assert.match(first.stdout, /--- jev review \(pre-screen/)
  assert.equal(readJob(fx, 'job-settled').jevReview.state, 'clean')

  const second = await run(['result', 'job-settled'], env, fx.root)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(stub.requests.length, afterFirst, 'the second result reuses the stored review')
})

test('a permanently failing API records state error without changing the job', async (t) => {
  const fx = fixture('fail')
  const { repo } = makeRepo(fx.root)
  const stub = await startStub(() => ({ status: 500, payload: { error: 'boom' } }))
  t.after(() => stub.close())
  const env = baseEnv(fx, stub.url)

  const { jobId, waited } = await runJobToCompletion(fx, env, repo)
  assert.equal(waited.status, 0, waited.stderr)
  const job = readJob(fx, jobId)
  assert.equal(job.state, 'done', 'a review failure never changes the job state')
  assert.equal(job.jevReview.state, 'error')

  const result = await run(['result', jobId], env, fx.root)
  assert.equal(result.status, 0, 'result exit code is unchanged')
  assert.match(result.stdout, /jev review: error/)
})
