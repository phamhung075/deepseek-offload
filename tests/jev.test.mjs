/**
 * Optional Jev judgments: `jev review`, `jev lint`, `jev watch`, and the
 * `start --jev-lint` hook.
 *
 * Every test points `TYPESAFE_API_URL` at a local HTTP stub and never calls the
 * real API. The stub records each request body so the assertions can read the
 * exact questions and hunks the runner sent, and the tests check the key is
 * never echoed back into stdout, stderr, or the report file.
 *
 * The runner is launched asynchronously (never `spawnSync`): the stub server
 * lives in this process, so blocking this event loop would deadlock the child's
 * HTTP call.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { callJev } from '../.agents/skills/deepseek-offload/scripts/jev/client.mjs'
import { jevFreeEnv } from './helpers/jev-env.mjs'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))
const SECRET_KEY = 'sk-test-SECRET-KEY-1234567890'

/** A fresh root for one test; never touches the real job store or DSH home. */
function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-jev-${name}-`))
}

/**
 * Start a stub System One server. `handler(parsed, count)` may return
 * `{status, payload}`; otherwise a clean answer is synthesised.
 */
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

/** A clean answer set: every noul yes, P(none) high, progress progressing. */
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
  if (questions.progress) {
    answers.progress = { choice: 'progressing', confidence: 0.9, probabilities: { progressing: 0.9 } }
  }
  return { model: 'jev-test', answers, usage: {} }
}

/**
 * Environment with a stub endpoint and a throwaway job store. A dummy key is
 * set by default so Jev is enabled; pass `{ key: null }` for the no-key path.
 */
function baseEnv(root, url, { key = SECRET_KEY } = {}) {
  const env = jevFreeEnv()
  if (key !== null) env.TYPESAFE_API_KEY = key
  env.TYPESAFE_API_URL = url
  // The runner treats DSH_OFFLOAD_JOB_DIR as the job root and appends `jobs/`.
  env.DSH_OFFLOAD_JOB_DIR = root
  env.DSH_HOME = path.join(root, 'dsh-home')
  env.DSH_BIN = '/bin/false'
  env.DEEPSEEK_MCP_SKIP = 'deepseek'
  env.DEEPSEEK_WORKSPACE_ATTACH = '0'
  return env
}

/** Run the runner without blocking this process's event loop (the stub lives here). */
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

// Fixture repositories must not inherit a delegated-job guard from an ambient
// GIT_CONFIG_GLOBAL.
const FIXTURE_GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const gitIn = (repo, ...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: FIXTURE_GIT_ENV })

/** A repo with a base commit, one commit touching three files, and untracked files. */
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
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bravo changed\n')
  fs.writeFileSync(path.join(repo, 'c.txt'), 'charlie changed\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-q', '-m', 'change three files')
  const head = gitIn(repo, 'rev-parse', 'HEAD').stdout.trim()

  fs.writeFileSync(path.join(repo, 'new-file.txt'), 'brand new file\n')
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n')
  return { repo, base, head }
}

/** Write a job record into the store the runner will read. */
function writeJob(root, record) {
  const jobsDir = path.join(root, 'jobs')
  fs.mkdirSync(jobsDir, { recursive: true })
  fs.writeFileSync(path.join(jobsDir, `${record.jobId}.json`), `${JSON.stringify(record, null, 2)}\n`)
  return jobsDir
}

const allHunkFiles = (requests) => {
  const files = []
  for (const body of requests) {
    for (const stateHunk of Object.values(body?.state?.hunks ?? {})) files.push(stateHunk.file)
    if (body?.state?.hunk?.file) files.push(body.state.hunk.file)
  }
  return files
}

test('no key: review, lint and the disabled line', async (t) => {
  const root = scratch('nokey')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url, { key: null })
  const repo = makeRepo(root)

  const review = await run(['jev', 'review', '--prompt-file', path.join(repo.repo, 'a.txt'), '--repo', repo.repo, '--base', repo.base], env)
  assert.equal(review.status, 0, review.stderr)
  assert.match(review.stdout, /jev: disabled — set TYPESAFE_API_KEY/)

  const lint = await run(['jev', 'lint', '--prompt-file', path.join(repo.repo, 'a.txt')], env)
  assert.equal(lint.status, 0, lint.stderr)
  assert.match(lint.stdout, /jev: disabled — set TYPESAFE_API_KEY/)

  assert.equal(stub.requests.length, 0, 'a disabled command must not call the API')
})

test('an ordinary start is unaffected without --jev-lint', async (t) => {
  const root = scratch('start')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)

  const start = await run(['start', 'update the parser and report what changed', '--detach', '--json'], env)
  assert.equal(start.status, 0, start.stderr)
  const job = JSON.parse(start.stdout)
  assert.equal(job.jobId.startsWith('job-'), true)
  assert.doesNotMatch(start.stdout, /jev:/)
  assert.doesNotMatch(start.stderr, /jev:/)
  assert.equal(stub.requests.length, 0, 'a plain start never calls Jev')

  assert.equal((await run(['cancel', job.jobId], env)).status, 0)
})

test('start --jev-lint prints advisory warnings and still starts the job', async (t) => {
  const root = scratch('start-lint')
  const stub = await startStub((parsed) => {
    if (!parsed?.questions?.single_outcome) return null
    return {
      payload: {
        model: 'jev-test',
        answers: {
          single_outcome: { noul: 0.9 },
          self_contained: { noul: 0.9 },
          write_policy_stated: { noul: 0.1 },
          is_investigation: { noul: 0.1 },
        },
        usage: {},
      },
    }
  })
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)

  const start = await run(['start', 'update server-go/internal/auth and report as JSON', '--jev-lint', '--detach', '--json'], env)
  assert.equal(start.status, 0, start.stderr)
  assert.match(start.stderr, /jev lint/)
  assert.match(start.stderr, /write_policy_stated/)
  const job = JSON.parse(start.stdout)
  assert.equal(stub.requests.length, 1, 'the lint ran once against the stub')
  assert.equal((await run(['cancel', job.jobId], env)).status, 0)
})

test('review flags a group when P(none) is low and lists where to look', async (t) => {
  const root = scratch('flagged')
  const repo = makeRepo(root)
  const stub = await startStub((parsed) => {
    if (!parsed?.questions?.odd_hunk) return null
    const probabilities = { none: 0.2 }
    let index = 0
    for (const id of Object.keys(parsed.state.hunks)) probabilities[id] = index++ === 0 ? 0.7 : 0.03
    return { payload: { model: 'jev-test', answers: { odd_hunk: { choice: 'h0', probabilities, confidence: 0.9 } }, usage: {} } }
  })
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = path.join(root, 'prompt.md')
  fs.writeFileSync(promptFile, 'Change a.txt, b.txt and c.txt, then report the result.\n')

  const out = await run(['jev', 'review', '--prompt-file', promptFile, '--repo', repo.repo, '--base', repo.base, '--head', repo.head], env)
  assert.equal(out.status, 3, out.stderr)
  assert.match(out.stdout, /look here/)
  assert.match(out.stdout, /pre-screen/i)
})

test('review exits clean when P(none) and in_scope are high', async (t) => {
  const root = scratch('clean')
  const repo = makeRepo(root)
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = path.join(root, 'prompt.md')
  fs.writeFileSync(promptFile, 'Change a.txt, b.txt and c.txt, then report the result.\n')

  const out = await run(['jev', 'review', '--prompt-file', promptFile, '--repo', repo.repo, '--base', repo.base, '--head', repo.head], env)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /look here  \(none\)/)
})

test('review sends the odd_hunk choice with h0..hN + none and the per-hunk nouls', async (t) => {
  const root = scratch('bodies')
  const repo = makeRepo(root)
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = path.join(root, 'prompt.md')
  fs.writeFileSync(promptFile, 'Change a.txt, b.txt and c.txt, then report the result.\n')

  const out = await run(['jev', 'review', '--prompt-file', promptFile, '--repo', repo.repo, '--base', repo.base, '--head', repo.head], env)
  assert.equal(out.status, 0, out.stderr)

  const bRequests = stub.requests.filter((body) => body?.questions?.odd_hunk)
  assert.ok(bRequests.length >= 2, 'one choice request per group (commit and untracked)')
  for (const body of bRequests) {
    const options = Object.keys(body.state.hunks)
    assert.equal(options[0], 'h0')
    assert.equal(options.at(-1), `h${options.length - 1}`)
    const criteria = body.questions.odd_hunk.criteria
    assert.ok('none' in criteria)
    for (const id of options) assert.ok(id in criteria)
  }

  const aRequests = stub.requests.filter((body) => body?.questions?.in_scope)
  assert.equal(aRequests.length, 4, 'three commit hunks plus one untracked hunk')
  for (const body of aRequests) {
    assert.ok(body.questions.unrequested, 'the same request carries unrequested')
    assert.match(body.questions.in_scope.instructions, /carry out something `work_order` asks for/)
  }

  const files = allHunkFiles(stub.requests)
  assert.ok(files.includes('new-file.txt'), 'the untracked file is reviewed as a hunk')
  assert.ok(!files.includes('package-lock.json'), 'a lockfile is skipped')
})

test('review follows resumeOf to the original work order and never leaks the key', async (t) => {
  const root = scratch('resume')
  const repo = makeRepo(root)
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const original = 'ORIGINAL-WORK-ORDER-MARKER: change a.txt, b.txt and c.txt.'
  writeJob(root, { jobId: 'job-original', state: 'done', prompt: original })
  const jobsDir = writeJob(root, { jobId: 'job-resumed', state: 'done', prompt: 'continue the interrupted run', resumeOf: 'job-original' })

  const out = await run(['jev', 'review', 'job-resumed', '--repo', repo.repo, '--base', repo.base, '--head', repo.head, '--json'], env)
  assert.equal(out.status, 0, out.stderr)

  const usedOriginal = stub.requests.some((body) => body?.state?.work_order === original)
  assert.equal(usedOriginal, true, 'the resumed job reviews against the original prompt')
  assert.ok(!stub.requests.some((body) => body?.state?.work_order === 'continue the interrupted run'))

  const reportPath = path.join(jobsDir, 'job-resumed.jev-review.json')
  assert.equal(fs.existsSync(reportPath), true, 'the JSON report is written beside the job')
  const reportText = fs.readFileSync(reportPath, 'utf8')
  assert.doesNotMatch(out.stdout, new RegExp(SECRET_KEY))
  assert.doesNotMatch(out.stderr, new RegExp(SECRET_KEY))
  assert.doesNotMatch(reportText, new RegExp(SECRET_KEY))
})

test('lint prints the --read-only advice for an investigation and exits 0', async (t) => {
  const root = scratch('lint')
  const stub = await startStub((parsed) => {
    if (!parsed?.questions?.is_investigation) return null
    return {
      payload: {
        model: 'jev-test',
        answers: {
          single_outcome: { noul: 0.9 },
          self_contained: { noul: 0.9 },
          write_policy_stated: { noul: 0.9 },
          is_investigation: { noul: 0.9 },
        },
        usage: {},
      },
    }
  })
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = path.join(root, 'prompt.md')
  fs.writeFileSync(promptFile, 'Investigate why server-go/internal/auth fails, then report findings as JSON with a 200 word budget.\n')

  const out = await run(['jev', 'lint', '--prompt-file', promptFile], env)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /--read-only/)

  const quiet = await run(['jev', 'lint', '--prompt-file', promptFile, '--read-only'], env)
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.doesNotMatch(quiet.stdout, /pass `--read-only`/)
})

test('watch exits 0 on a settled job without calling the API', async (t) => {
  const root = scratch('watch-done')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  writeJob(root, { jobId: 'job-done', state: 'done', prompt: 'anything' })

  const out = await run(['jev', 'watch', 'job-done', '--interval-ms', '10', '--timeout-ms', '2000'], env)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /settled at state=done/)
  assert.equal(stub.requests.length, 0)
})

test('watch exits 4 on a confident looping verdict', async (t) => {
  const root = scratch('watch-loop')
  const stub = await startStub((parsed) => {
    if (!parsed?.questions?.progress) return null
    return {
      payload: {
        model: 'jev-test',
        answers: { progress: { choice: 'looping', confidence: 0.9, probabilities: { looping: 0.9 } } },
        usage: {},
      },
    }
  })
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  writeJob(root, { jobId: 'job-loop', state: 'running', prompt: 'change a.txt and report' })
  const tailStub = path.join(root, 'tail-stub.mjs')
  fs.writeFileSync(tailStub, "process.stdout.write('12:00:00  tool bash: echo same\\n12:00:01  tool bash: echo same\\n')\n")
  env.DSH_OFFLOAD_SESSION_TAIL = tailStub

  const out = await run(['jev', 'watch', 'job-loop', '--interval-ms', '10', '--timeout-ms', '5000'], env)
  assert.equal(out.status, 4, out.stderr)
  assert.match(out.stdout, /looping/)
  assert.match(out.stdout, /last activity:/)
})

test('a 429 is retried and the request succeeds', async (t) => {
  const root = scratch('retry')
  const stub = await startStub((_parsed, count) => {
    if (count === 1) return { status: 429, payload: { error: 'rate limited' } }
    return null
  })
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = path.join(root, 'prompt.md')
  fs.writeFileSync(promptFile, 'Change server-go/internal/auth/keycloak.go and report the result as JSON.\n')

  const out = await run(['jev', 'lint', '--prompt-file', promptFile], env)
  assert.equal(out.status, 0, out.stderr)
  assert.ok(stub.requests.length >= 2, 'the first 429 was retried')
})

test('a request timeout is treated as a retryable network error', async () => {
  let calls = 0
  const fetchImpl = (_url, options) => {
    calls += 1
    if (calls === 1) {
      // Hang until the request timeout aborts the signal, like a stalled socket.
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason))
      })
    }
    return Promise.resolve({ ok: true, json: async () => ({ model: 'jev-test', answers: {} }) })
  }
  const env = { TYPESAFE_API_KEY: 'k', TYPESAFE_API_URL: 'http://127.0.0.1:1/v1/systemone' }
  const result = await callJev({
    state: {},
    questions: {},
    env,
    fetchImpl,
    maxTries: 2,
    requestTimeoutMs: 20,
    sleep: () => Promise.resolve(),
  })
  assert.equal(calls, 2, 'the timeout was retried')
  assert.equal(result.attempts, 2)
})
