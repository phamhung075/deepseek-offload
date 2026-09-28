/**
 * Citation-path resolution in `jev claims` (a bare or partial path is resolved
 * to its unique tracked file, several matches are `skipped.ambiguous`) and the
 * pathScope same-directory rule (a new file beside a named file is in scope,
 * one in another directory still warns).
 *
 * The API-test boilerplate mirrors `jev-hardening.test.mjs`: every API test
 * points `TYPESAFE_API_URL` at a local stub, the runner is spawned
 * asynchronously because the stub lives in this process, and pure helpers are
 * imported directly so the resolution rules are also tested without a key.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readEvidence,
  resolveTrackedPath,
  listTrackedFiles,
  AMBIGUOUS_CITED_PATH,
} from '../.agents/skills/deepseek-offload/scripts/jev/claims.mjs'
import { isUnderNamedPath } from '../.agents/skills/deepseek-offload/scripts/jev/rules.mjs'
import { jevFreeEnv } from './helpers/jev-env.mjs'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))
const SECRET_KEY = 'sk-test-SECRET-KEY-paths'

function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-jev-paths-${name}-`))
}

const FIXTURE_GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const gitIn = (repo, ...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: FIXTURE_GIT_ENV })

/** A file body whose line 5 is `marker`, so a resolved read is identifiable. */
function body(marker, { lines = 12, markerLine = 5 } = {}) {
  return `${Array.from({ length: lines }, (_v, i) => (i === markerLine - 1 ? marker : `line ${i + 1}`)).join('\n')}\n`
}

/** A repo with a base commit and a second commit that writes `changeFiles`. */
function makeRepo(root, baseFiles, changeFiles) {
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  gitIn(repo, 'init', '-q')
  gitIn(repo, 'config', 'user.email', 'test@example.com')
  gitIn(repo, 'config', 'user.name', 'Test')
  for (const [name, text] of Object.entries(baseFiles)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
    fs.writeFileSync(path.join(repo, name), text)
  }
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'base')
  const base = gitIn(repo, 'rev-parse', 'HEAD').stdout.trim()
  for (const [name, text] of Object.entries(changeFiles)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
    fs.writeFileSync(path.join(repo, name), text)
  }
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'change')
  return { repo, base, head: gitIn(repo, 'rev-parse', 'HEAD').stdout.trim() }
}

function writeJob(root, record) {
  const jobsDir = path.join(root, 'jobs')
  fs.mkdirSync(jobsDir, { recursive: true })
  fs.writeFileSync(path.join(jobsDir, `${record.jobId}.json`), `${JSON.stringify(record, null, 2)}\n`)
  return jobsDir
}

async function startStub(handler = () => null) {
  const requests = []
  const server = http.createServer((req, res) => {
    let text = ''
    req.on('data', (chunk) => { text += chunk })
    req.on('end', () => {
      let parsed = null
      try { parsed = JSON.parse(text) } catch { /* recorded as null */ }
      requests.push(parsed)
      const override = handler(parsed, requests.length) ?? null
      res.writeHead(override?.status ?? 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(override?.payload ?? answerFor(parsed)))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/systemone`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function answerFor(parsed) {
  const questions = parsed?.questions ?? {}
  const answers = {}
  if (questions.odd_hunk) {
    const probabilities = { none: 0.9 }
    for (const id of Object.keys(parsed?.state?.hunks ?? {})) probabilities[id] = 0.05
    answers.odd_hunk = { choice: 'none', probabilities, confidence: 0.9 }
  }
  for (const id of ['unrequested', 'supported']) if (questions[id]) answers[id] = { noul: 0.1 }
  if (questions.in_scope) answers.in_scope = { noul: 0.9 }
  return { model: 'jev-test', answers, usage: {} }
}

function baseEnv(root, url) {
  const env = jevFreeEnv()
  env.TYPESAFE_API_KEY = SECRET_KEY
  env.TYPESAFE_API_URL = url
  env.DSH_OFFLOAD_JOB_DIR = root
  env.DSH_HOME = path.join(root, 'dsh-home')
  env.DSH_BRIDGE_PROJECT_ROOT = root
  env.DSH_BIN = '/bin/false'
  env.DEEPSEEK_MCP_SKIP = 'deepseek'
  env.DEEPSEEK_WORKSPACE_ATTACH = '0'
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  return env
}

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

// ------------------------------------------- A: citation resolution (pure)

test('resolveTrackedPath matches by suffix on a / boundary', () => {
  assert.deepEqual(resolveTrackedPath('mcp.go', ['pkg/mcp.go']), { path: 'pkg/mcp.go' })
  assert.deepEqual(resolveTrackedPath('billing/postgres.go', ['pkg/billing/postgres.go']), { path: 'pkg/billing/postgres.go' })
  assert.deepEqual(resolveTrackedPath('./x/y.go', ['p/x/y.go']), { path: 'p/x/y.go' })
  assert.deepEqual(resolveTrackedPath('mcp.go', ['a/mcp.go', 'b/mcp.go']), { ambiguous: true })
  assert.equal(resolveTrackedPath('mcp.go', ['a/other.go']), null)
})

test('readEvidence resolves a partial worktree path and keeps an absolute one', () => {
  const root = scratch('worktree')
  const { repo } = makeRepo(root, { 'pkg/billing/postgres.go': body('// worktree marker') }, { 'pkg/billing/postgres.go': body('// worktree marker two') })

  const relative = readEvidence(repo, { worktree: true }, 'billing/postgres.go', 5)
  assert.equal(relative.path, 'pkg/billing/postgres.go')
  assert.match(relative.lines, /worktree marker two/)

  const absolute = path.join(repo, 'pkg/billing/postgres.go')
  const unchanged = readEvidence(repo, { worktree: true }, absolute, 5)
  assert.equal(unchanged.path, absolute, 'an absolute path is read as given')

  const ambiguousRepo = path.join(root, 'ambiguous')
  fs.mkdirSync(path.join(ambiguousRepo, 'a'), { recursive: true })
  fs.mkdirSync(path.join(ambiguousRepo, 'b'), { recursive: true })
  gitIn(ambiguousRepo, 'init', '-q')
  gitIn(ambiguousRepo, 'config', 'user.email', 'test@example.com')
  gitIn(ambiguousRepo, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(ambiguousRepo, 'a/mod.go'), body('// a'))
  fs.writeFileSync(path.join(ambiguousRepo, 'b/mod.go'), body('// b'))
  gitIn(ambiguousRepo, 'add', '-A')
  gitIn(ambiguousRepo, 'commit', '-q', '-m', 'base')
  assert.throws(
    () => readEvidence(ambiguousRepo, { worktree: true }, 'mod.go', 1),
    (error) => error.code === AMBIGUOUS_CITED_PATH,
  )
  assert.deepEqual(listTrackedFiles(ambiguousRepo, { worktree: true }).sort(), ['a/mod.go', 'b/mod.go'])
})

test('claims resolve bare and partial citations, count ambiguous ones, and keep a literal path', async (t) => {
  const root = scratch('claims')
  const { repo } = makeRepo(
    root,
    {
      'pkg/billing/postgres.go': body('// base postgres'),
      'a/mod.go': body('// mod a'),
      'b/mod.go': body('// mod b'),
    },
    { 'pkg/billing/postgres.go': body('// head postgres marker') },
  )
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const jobId = 'job-paths'
  const jobsDir = writeJob(root, { jobId, state: 'done', prompt: 'claim paths', reviewRepo: repo })
  fs.writeFileSync(
    path.join(jobsDir, `${jobId}.result.md`),
    'The guard is in postgres.go:5 and blocks writes.\n'
    + 'The billing guard is in billing/postgres.go:5 and blocks writes.\n'
    + 'The module in mod.go:1 is unclear.\n'
    + 'The literal path pkg/billing/postgres.go:5 is stable.\n',
  )

  const text = await run(['jev', 'claims', jobId, '--repo', repo], env)
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /3\/4 citation\(s\) checked/)
  assert.match(text.stdout, /skipped 0 missing file\(s\), 1 ambiguous/)

  const json = await run(['jev', 'claims', jobId, '--repo', repo, '--json'], env)
  assert.equal(json.status, 0, json.stderr)
  const report = JSON.parse(json.stdout)
  assert.equal(report.considered, 3)
  assert.deepEqual(report.skipped, { missingFile: 0, ambiguous: 1, cap: 0 })
  assert.equal(report.unsupportedCount, 3)
  const byCite = Object.fromEntries(report.unsupported.map((claim) => [claim.citedPath, claim]))
  assert.equal(byCite['postgres.go'].path, 'pkg/billing/postgres.go', 'a bare basename resolves')
  assert.equal(byCite['billing/postgres.go'].path, 'pkg/billing/postgres.go', 'a partial path resolves')
  assert.equal(byCite['pkg/billing/postgres.go'].path, 'pkg/billing/postgres.go', 'a literal path is unchanged')
  for (const request of stub.requests) {
    assert.match(request.state.evidence.lines, /head postgres marker/, 'evidence comes from the resolved file')
  }
})

// ------------------------------------------------- B: pathScope (pure)

test('a hunk in the same directory as a named file is in scope', () => {
  const named = [{ value: 'server-go/internal/mcp/mcp.go' }]
  assert.equal(isUnderNamedPath('server-go/internal/mcp/batch.go', named), true)
  assert.equal(isUnderNamedPath('server-go/internal/other/batch.go', named), false)
  assert.equal(isUnderNamedPath('server-go/batch.go', named), false)

  const partial = [{ value: 'internal/webhooks/telegram.go' }]
  assert.equal(isUnderNamedPath('server-go/internal/webhooks/guard.go', partial), true, 'the named path is a suffix')
  assert.equal(isUnderNamedPath('server-go/internal/webhooks/sub/guard.go', partial), false)

  const directory = [{ value: 'server-go/internal/mcp' }]
  assert.equal(isUnderNamedPath('server-go/internal/mcp/batch.go', directory), true, 'directory naming is unchanged')
  assert.equal(isUnderNamedPath('server-go/internal/other/batch.go', directory), false)
  assert.equal(isUnderNamedPath('deep/x/mcp.go', [{ value: 'mcp.go' }]), true, 'a bare name is unchanged')
})

// ------------------------------------------------- B: pathScope (runner)

function writeConfig(root, config) {
  const file = path.join(root, 'jev.json')
  fs.writeFileSync(file, JSON.stringify(config))
  return file
}

test('pathScope does not warn on a sibling file and still warns on another directory', async (t) => {
  const siblingRoot = scratch('sibling')
  const sibling = await startStub()
  t.after(() => sibling.close())
  const siblingEnv = baseEnv(siblingRoot, sibling.url)
  siblingEnv.DSH_OFFLOAD_JEV_CONFIG = writeConfig(siblingRoot, { pathScope: 'flag' })
  const siblingRepo = makeRepo(
    siblingRoot,
    { 'server-go/internal/mcp/mcp.go': body('// base mcp') },
    {
      'server-go/internal/mcp/mcp.go': body('// edited mcp'),
      'server-go/internal/mcp/batch.go': body('// new sibling'),
    },
  )
  const siblingPrompt = path.join(siblingRoot, 'prompt.md')
  fs.writeFileSync(siblingPrompt, 'Edit server-go/internal/mcp/mcp.go and add a helper next to it.\n')

  const ok = await run(['jev', 'review', '--prompt-file', siblingPrompt, '--repo', siblingRepo.repo, '--base', siblingRepo.base, '--head', siblingRepo.head], siblingEnv)
  assert.equal(ok.status, 0, ok.stderr)
  assert.doesNotMatch(ok.stdout, /outside paths named in the work order/)
  assert.ok(sibling.requests.length > 0, 'no false finding means Jev still runs')

  const otherRoot = scratch('otherdir')
  const other = await startStub()
  t.after(() => other.close())
  const otherEnv = baseEnv(otherRoot, other.url)
  otherEnv.DSH_OFFLOAD_JEV_CONFIG = writeConfig(otherRoot, { pathScope: 'flag' })
  const otherRepo = makeRepo(
    otherRoot,
    { 'server-go/internal/mcp/mcp.go': body('// base mcp') },
    {
      'server-go/internal/mcp/mcp.go': body('// edited mcp'),
      'server-go/internal/other/batch.go': body('// other dir'),
    },
  )
  const otherPrompt = path.join(otherRoot, 'prompt.md')
  fs.writeFileSync(otherPrompt, 'Edit server-go/internal/mcp/mcp.go and report.\n')

  const flagged = await run(['jev', 'review', '--prompt-file', otherPrompt, '--repo', otherRepo.repo, '--base', otherRepo.base, '--head', otherRepo.head], otherEnv)
  assert.equal(flagged.status, 3, flagged.stderr)
  assert.match(flagged.stdout, /outside paths named in the work order/)
  assert.equal(other.requests.length, 0, 'a flagging rule skips Jev')
})
