/**
 * The working-tree review group, the self-checkout `reviewScope` guard, claims
 * on an empty diff, the stored lint, and the experimental labels.
 *
 * Every test points `TYPESAFE_API_URL` at a local HTTP stub built with
 * `jevFreeEnv` and never calls the real API. The runner is spawned
 * asynchronously (never `spawnSync`): the stub lives in this process, so
 * blocking this event loop would deadlock the child's HTTP call.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { jevFreeEnv } from './helpers/jev-env.mjs'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))
const SECRET_KEY = 'sk-test-SECRET-KEY-worktree'

/** A fresh root for one test; never touches the real job store or DSH home. */
function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-jev-wt-${name}-`))
}

/** A stub System One server; `handler(parsed, count)` may override the answer. */
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

/** A clean answer set covering every Jev question these tests can reach. */
function answerFor(parsed) {
  const questions = parsed?.questions ?? {}
  const answers = {}
  for (const [id, question] of Object.entries(questions)) {
    if (id === 'odd_hunk' && question.type === 'choice') {
      const probabilities = { none: 0.9 }
      for (const hunkId of Object.keys(parsed?.state?.hunks ?? {})) probabilities[hunkId] = 0.05
      answers.odd_hunk = { choice: 'none', probabilities, confidence: 0.9 }
    } else if (question.type === 'choice') {
      const options = Object.keys(question.criteria ?? {})
      const pick = options.find((option) => option !== 'none') ?? 'none'
      const probabilities = {}
      for (const option of options) probabilities[option] = option === pick ? 0.8 : 0.05
      answers[id] = { choice: pick, confidence: 0.8, probabilities }
    } else if (id === 'unrequested') {
      answers[id] = { noul: 0.1 }
    } else {
      answers[id] = { noul: 0.9 }
    }
  }
  return { model: 'jev-test', answers, usage: {} }
}

/** Environment with a stub endpoint and a throwaway job store. */
function baseEnv(root, url, { key = SECRET_KEY } = {}) {
  const env = jevFreeEnv()
  if (key !== null) env.TYPESAFE_API_KEY = key
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

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

/** `git -C repo ...` with the fixture guard. */
function gitIn(repo, ...args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV })
}

/** Init a repo with a base commit and one later commit that changes `a.txt`. */
function makeRepo(root) {
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  gitIn(repo, 'init', '-q')
  gitIn(repo, 'config', 'user.email', 'test@example.com')
  gitIn(repo, 'config', 'user.name', 'Test')
  for (const [name, text] of [['a.txt', 'alpha\n'], ['b.txt', 'bravo\n'], ['c.txt', 'charlie\n']]) {
    fs.writeFileSync(path.join(repo, name), text)
  }
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'base')
  const base = gitIn(repo, 'rev-parse', 'HEAD').stdout.trim()
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha changed\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'change a.txt')
  const head = gitIn(repo, 'rev-parse', 'HEAD').stdout.trim()
  return { repo, base, head }
}

/** Init a repo whose HEAD is the base, so `base..HEAD` is empty. */
function makeCleanRepo(root) {
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  gitIn(repo, 'init', '-q')
  gitIn(repo, 'config', 'user.email', 'test@example.com')
  gitIn(repo, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'base')
  const base = gitIn(repo, 'rev-parse', 'HEAD').stdout.trim()
  return { repo, base }
}

/** Every hunk file the stub saw, across the per-hunk and per-group requests. */
function allHunkFiles(requests) {
  const files = []
  for (const body of requests) {
    for (const stateHunk of Object.values(body?.state?.hunks ?? {})) files.push(stateHunk.file)
    if (body?.state?.hunk?.file) files.push(body.state.hunk.file)
  }
  return files
}

const writePrompt = (root, text) => {
  const file = path.join(root, 'prompt.md')
  fs.writeFileSync(file, text)
  return file
}

/** A `--json` review report. */
async function reviewJson(env, promptFile, repo, base) {
  const out = await run(['jev', 'review', '--prompt-file', promptFile, '--repo', repo, '--base', base, '--json'], env)
  return { out, report: out.status === 0 || out.status === 3 ? JSON.parse(out.stdout) : null }
}

// ---------------------------------------------------------------------------
// Item 1: the working-tree group
// ---------------------------------------------------------------------------

test('a staged-only tracked change becomes one worktree group with its hunk', async (t) => {
  const root = scratch('staged')
  const { repo, base } = makeRepo(root)
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bravo staged\n')
  gitIn(repo, 'add', 'b.txt')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = writePrompt(root, 'Change a.txt and b.txt, then report the result.\n')

  const { out, report } = await reviewJson(env, promptFile, repo, base)
  assert.equal(out.status, 0, out.stderr)
  const worktree = report.groups.filter((group) => group.kind === 'worktree')
  assert.equal(worktree.length, 1, out.stdout)
  assert.equal(worktree[0].sha, 'worktree')
  assert.equal(worktree[0].subject, 'uncommitted changes')
  assert.deepEqual(worktree[0].hunks.map((hunk) => hunk.file), ['b.txt'])
  assert.ok(report.groups.some((group) => group.kind === 'commit' && group.hunks.some((hunk) => hunk.file === 'a.txt')))
})

test('an unstaged-only tracked change is the same worktree group', async (t) => {
  const root = scratch('unstaged')
  const { repo, base } = makeRepo(root)
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bravo unstaged\n')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = writePrompt(root, 'Change a.txt and b.txt, then report the result.\n')

  const { out, report } = await reviewJson(env, promptFile, repo, base)
  assert.equal(out.status, 0, out.stderr)
  const worktree = report.groups.filter((group) => group.kind === 'worktree')
  assert.equal(worktree.length, 1)
  assert.deepEqual(worktree[0].hunks.map((hunk) => hunk.file), ['b.txt'])
})

test('a committed hunk plus a staged change gives one commit group and one worktree group, no repeat', async (t) => {
  const root = scratch('commit-plus-worktree')
  const { repo, base } = makeRepo(root)
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bravo staged\n')
  gitIn(repo, 'add', 'b.txt')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = writePrompt(root, 'Change a.txt and b.txt, then report the result.\n')

  const { out, report } = await reviewJson(env, promptFile, repo, base)
  assert.equal(out.status, 0, out.stderr)
  const commits = report.groups.filter((group) => group.kind === 'commit')
  const worktree = report.groups.filter((group) => group.kind === 'worktree')
  assert.equal(commits.length, 1)
  assert.deepEqual(commits[0].hunks.map((hunk) => hunk.file), ['a.txt'])
  assert.equal(worktree.length, 1)
  assert.deepEqual(worktree[0].hunks.map((hunk) => hunk.file), ['b.txt'])
  assert.equal(allHunkFiles(stub.requests).filter((file) => file === 'a.txt').length >= 1, true)
  assert.equal(report.groups.filter((group) => group.hunks.some((hunk) => hunk.file === 'a.txt')).length, 1)
})

test('a low P(none) on the worktree group flags the review', async (t) => {
  const root = scratch('worktree-flagged')
  const { repo, base } = makeRepo(root)
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bravo smuggled\n')
  const stub = await startStub((parsed) => {
    if (!parsed?.questions?.odd_hunk) return null
    const probabilities = { none: 0.2 }
    let index = 0
    for (const id of Object.keys(parsed.state.hunks)) probabilities[id] = index++ === 0 ? 0.7 : 0.03
    return { payload: { model: 'jev-test', answers: { odd_hunk: { choice: 'h0', probabilities, confidence: 0.9 } }, usage: {} } }
  })
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = writePrompt(root, 'Change a.txt and report the result.\n')

  const out = await run(['jev', 'review', '--prompt-file', promptFile, '--repo', repo, '--base', base], env)
  assert.equal(out.status, 3, out.stdout + out.stderr)
  assert.match(out.stdout, /worktree  uncommitted changes/)
})

test('nothing changed still prints "no changes in the review range"', async (t) => {
  const root = scratch('nochanges')
  const { repo, base } = makeCleanRepo(root)
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = writePrompt(root, 'Change a.txt and report the result.\n')

  const out = await run(['jev', 'review', '--prompt-file', promptFile, '--repo', repo, '--base', base], env)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /no changes in the review range/)
  assert.equal(stub.requests.length, 0)
})

test('a neverTouch path modified but uncommitted is a rule-flagged review', async (t) => {
  const root = scratch('nevertouch-worktree')
  const { repo, base } = makeRepo(root)
  fs.mkdirSync(path.join(repo, 'secrets'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'secrets', 'key.pem'), 'PRIVATE\n')
  gitIn(repo, 'add', '-A')
  const config = path.join(root, 'jev.json')
  fs.writeFileSync(config, JSON.stringify({ neverTouch: ['secrets/**'] }))
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  env.DSH_OFFLOAD_JEV_CONFIG = config
  const promptFile = writePrompt(root, 'Change a.txt and report the result.\n')

  const out = await run(['jev', 'review', '--prompt-file', promptFile, '--repo', repo, '--base', base], env)
  assert.equal(out.status, 3, out.stdout + out.stderr)
  assert.match(out.stdout, /never-touch path/)
  assert.equal(stub.requests.length, 0, 'a flagging rule skips Jev')
})
