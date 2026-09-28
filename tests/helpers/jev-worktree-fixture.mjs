/**
 * Shared harness for the Jev worktree/lint/experimental test files.
 *
 * Every test builds its environment through `baseEnv`, which starts from
 * `jevFreeEnv()` and points `TYPESAFE_API_URL` at the per-test local stub, so
 * an ambient Jev variable can never decide a child's behaviour and the real API
 * is never called. The runner is spawned asynchronously (never `spawnSync`):
 * the stub lives in the test process, so blocking its event loop would deadlock
 * the child's HTTP call.
 */
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { jevFreeEnv } from './jev-env.mjs'

export const RUNNER = fileURLToPath(new URL('../../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))
export const SECRET_KEY = 'sk-test-SECRET-KEY-worktree'

/** A fresh root for one test; never touches the real job store or DSH home. */
export function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-jev-wt-${name}-`))
}

/** A stub System One server; `handler(parsed, count)` may override the answer. */
export async function startStub(handler = () => null) {
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
export function baseEnv(root, url, { key = SECRET_KEY } = {}) {
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
export function run(args, env, { cwd } = {}) {
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
export function gitIn(repo, ...args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV })
}

/** Init a repo directory with one base commit holding a.txt/b.txt/c.txt. */
export function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true })
  gitIn(repo, 'init', '-q')
  gitIn(repo, 'config', 'user.email', 'test@example.com')
  gitIn(repo, 'config', 'user.name', 'Test')
  for (const [name, text] of [['a.txt', 'alpha\n'], ['b.txt', 'bravo\n'], ['c.txt', 'charlie\n']]) {
    fs.writeFileSync(path.join(repo, name), text)
  }
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'base')
  return gitIn(repo, 'rev-parse', 'HEAD').stdout.trim()
}

/** Init a repo with a base commit and one later commit that changes `a.txt`. */
export function makeRepo(root) {
  const repo = path.join(root, 'repo')
  const base = initRepo(repo)
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha changed\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'change a.txt')
  const head = gitIn(repo, 'rev-parse', 'HEAD').stdout.trim()
  return { repo, base, head }
}

/** A second, separate repository under `root` (a "clone"-like peer). */
export function makePeerRepo(root) {
  const repo = path.join(root, 'peer')
  const base = initRepo(repo)
  return { repo, base }
}

/** Init a repo whose HEAD is the base, so `base..HEAD` is empty. */
export function makeCleanRepo(root) {
  const repo = path.join(root, 'repo')
  const base = initRepo(repo)
  return { repo, base }
}

/** Write a job record into the store and return the jobs dir. */
export function writeJob(root, record) {
  const jobsDir = path.join(root, 'jobs')
  fs.mkdirSync(jobsDir, { recursive: true })
  fs.writeFileSync(path.join(jobsDir, `${record.jobId}.json`), `${JSON.stringify(record, null, 2)}\n`)
  return jobsDir
}

/** Read a job record back from the store. */
export function readJob(root, jobId) {
  return JSON.parse(fs.readFileSync(path.join(root, 'jobs', `${jobId}.json`), 'utf8'))
}

/** Every hunk file the stub saw, across the per-hunk and per-group requests. */
export function allHunkFiles(requests) {
  const files = []
  for (const body of requests) {
    for (const stateHunk of Object.values(body?.state?.hunks ?? {})) files.push(stateHunk.file)
    if (body?.state?.hunk?.file) files.push(body.state.hunk.file)
  }
  return files
}

/** Write a prompt file under `root` and return its path. */
export function writePrompt(root, text) {
  const file = path.join(root, 'prompt.md')
  fs.writeFileSync(file, text)
  return file
}
