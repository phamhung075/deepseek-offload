/**
 * The stored lint (`jevLint`) and the experimental labels.
 *
 * The harness (stub server, `jevFreeEnv`-based environment, temp repos) lives in
 * `./helpers/jev-worktree-fixture.mjs`; every test points `TYPESAFE_API_URL` at a
 * local stub and never calls the real API.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  startStub,
  baseEnv,
  run,
  makeCleanRepo,
  writeJob,
  readJob,
  writePrompt,
  scratch,
} from './helpers/jev-worktree-fixture.mjs'

const LINT_PROMPT = 'Change server-go/internal/auth/keycloak.go to reject an expired token, then report the result as JSON with a 200 word budget and one paragraph per finding.\n'

// ---------------------------------------------------------------------------
// Item 4: the stored lint record
// ---------------------------------------------------------------------------

test('start --jev-lint stores the findings on the job record', async (t) => {
  const root = scratch('lint-store')
  const stub = await startStub((parsed) => {
    if (!parsed?.questions?.self_contained) return null
    return {
      payload: {
        model: 'jev-test',
        answers: {
          single_outcome: { noul: 0.1 },
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

  const started = await run(['start', LINT_PROMPT, '--jev-lint', '--detach', '--json'], env, { cwd: root })
  assert.equal(started.status, 0, started.stderr)
  const job = JSON.parse(started.stdout)
  const record = readJob(root, job.jobId)
  assert.equal(record.jevLint.state, 'warn')
  assert.ok(record.jevLint.warnings.some((finding) => finding.id === 'write_policy_stated'))
  assert.ok(record.jevLint.warnings.every((finding) => typeof finding.text === 'string' && finding.text !== ''))
  assert.ok(record.jevLint.info.some((finding) => finding.id === 'single_outcome'))
  assert.equal(stub.requests.length, 1)
  await run(['cancel', job.jobId], env, { cwd: root })
})

test('result, status and --json show the stored lint', async (t) => {
  const root = scratch('lint-show')
  const { repo } = makeCleanRepo(root)
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const jobId = 'job-lint-show'
  const jobsDir = writeJob(root, {
    jobId,
    state: 'done',
    prompt: 'x',
    cwd: repo,
    jevLint: {
      state: 'warn',
      warnings: [{ id: 'write_policy_stated', text: 'does not clearly state whether the worker may modify files (write_policy_stated=0.100)' }],
      info: [{ id: 'single_outcome', text: 'may bundle several outcomes (single_outcome=0.100)' }],
    },
    startedAt: Date.now() - 5000,
    finishedAt: Date.now() - 1000,
  })
  fs.writeFileSync(path.join(jobsDir, `${jobId}.result.md`), 'lint fixture\n')

  const result = await run(['result', jobId], env, { cwd: root })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /lint: 1 warning\(s\)/)
  assert.match(result.stdout, /write_policy_stated=0\.100/)
  assert.match(result.stdout, /info: single_outcome/)

  const status = await run(['status', jobId], env, { cwd: root })
  assert.equal(status.status, 0, status.stderr)
  assert.match(status.stdout, /jev lint  warn/)

  const json = await run(['result', jobId, '--json'], env, { cwd: root })
  assert.equal(json.status, 0, json.stderr)
  assert.equal(JSON.parse(json.stdout).jevLint.state, 'warn')

  writeJob(root, { jobId: 'job-no-lint', state: 'done', prompt: 'x', cwd: repo, startedAt: Date.now() - 5000, finishedAt: Date.now() - 1000 })
  fs.writeFileSync(path.join(jobsDir, 'job-no-lint.result.md'), 'no lint fixture\n')
  const plain = await run(['result', 'job-no-lint'], env, { cwd: root })
  assert.equal(plain.status, 0, plain.stderr)
  assert.doesNotMatch(plain.stdout, /lint:/, 'a job without a stored lint prints nothing')
})

test('start --jev-lint without a key stores disabled and never calls the stub', async (t) => {
  const root = scratch('lint-nokey')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url, { key: null })

  const started = await run(['start', LINT_PROMPT, '--jev-lint', '--detach', '--json'], env, { cwd: root })
  assert.equal(started.status, 0, started.stderr)
  const job = JSON.parse(started.stdout)
  assert.equal(readJob(root, job.jobId).jevLint.state, 'disabled')
  assert.equal(stub.requests.length, 0, 'a disabled lint makes no request')
  await run(['cancel', job.jobId], env, { cwd: root })
})

// ---------------------------------------------------------------------------
// Item 5: the experimental labels
// ---------------------------------------------------------------------------

/** The `experimental:` line every opt-in emits. */
const EXPERIMENTAL_RE = /experimental: /

test('jev route prints one experimental line and folds the caveat into it', async (t) => {
  const root = scratch('exp-route')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = writePrompt(root, 'Do something as JSON.\n')
  const rolesFile = path.join(root, 'roles.json')
  fs.writeFileSync(rolesFile, JSON.stringify([{ name: 'QA-Auditor', mission: 'Tests' }]))

  const out = await run(['jev', 'route', '--prompt-file', promptFile, '--roles-file', rolesFile], env)
  assert.equal(out.status, 0, out.stderr)
  const experimental = out.stderr.split('\n').filter((line) => EXPERIMENTAL_RE.test(line))
  assert.equal(experimental.length, 1, out.stderr)
  assert.match(experimental[0], /40\.9% top-1/)
})

test('jev skills prints one experimental line', async (t) => {
  const root = scratch('exp-skills')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const skillsDir = path.join(root, 'skills')
  for (const name of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(skillsDir, name), { recursive: true })
    fs.writeFileSync(path.join(skillsDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Does ${name}.\n---\n# ${name}\n`)
  }
  const promptFile = writePrompt(root, 'Do alpha work as JSON.\n')

  const out = await run(['jev', 'skills', '--prompt-file', promptFile, '--skills-dir', skillsDir], env)
  assert.equal(out.status, 0, out.stderr)
  const experimental = out.stderr.split('\n').filter((line) => EXPERIMENTAL_RE.test(line))
  assert.equal(experimental.length, 1, out.stderr)
  assert.match(experimental[0], /UNVALIDATED/)
})

test('jev conflicts prints one experimental line', async (t) => {
  const root = scratch('exp-conflicts')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const jobsDir = path.join(root, 'jobs')
  fs.mkdirSync(jobsDir, { recursive: true })
  for (const [jobId, text] of [
    ['job-aa', '- The handler in a.go:12 leaks.\n'],
    ['job-bb', '- The handler in a.go:12 is fine.\n'],
  ]) {
    fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), JSON.stringify({ jobId, state: 'done', prompt: 'x' }))
    fs.writeFileSync(path.join(jobsDir, `${jobId}.result.md`), text)
  }

  const out = await run(['jev', 'conflicts', 'job-aa', 'job-bb'], env)
  assert.equal(out.status, 0, out.stderr)
  const experimental = out.stderr.split('\n').filter((line) => EXPERIMENTAL_RE.test(line))
  assert.equal(experimental.length, 1, out.stderr)
  assert.match(experimental[0], /synthetic/)
})

test('wait --jev-watch prints one experimental line', async (t) => {
  const root = scratch('exp-watch')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  writeJob(root, { jobId: 'job-watched', state: 'done', prompt: 'finished', startedAt: Date.now() - 1000, finishedAt: Date.now() })

  const out = await run(['wait', 'job-watched', '--jev-watch', '--timeout-ms', '2000'], env, { cwd: root })
  assert.equal(out.status, 0, out.stderr)
  const experimental = out.stderr.split('\n').filter((line) => EXPERIMENTAL_RE.test(line))
  assert.equal(experimental.length, 1, out.stderr)
  assert.match(experimental[0], /progress triage/)
})

test('start --jev-mcp prints one experimental line', async (t) => {
  const root = scratch('exp-mcp')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)

  const out = await run(['start', 'check the diff and report as JSON', '--jev-mcp', '--detach', '--json'], env, { cwd: root })
  assert.equal(out.status, 0, out.stderr)
  const experimental = out.stderr.split('\n').filter((line) => EXPERIMENTAL_RE.test(line))
  assert.equal(experimental.length, 1, out.stderr)
  assert.match(experimental[0], /self-check/)
  const job = JSON.parse(out.stdout)
  await run(['cancel', job.jobId], env, { cwd: root })
})

test('the Jev branch of jev triage prints one experimental line', async (t) => {
  const root = scratch('exp-triage')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  env.DSH_OFFLOAD_SESSION_TAIL = path.join(root, 'tail-stub.mjs')
  fs.writeFileSync(env.DSH_OFFLOAD_SESSION_TAIL, "process.stdout.write('12:00:00  tool bash: echo hi\\n')\n")
  writeJob(root, { jobId: 'job-weird', state: 'error', error: 'the flux capacitor inverted' })

  const out = await run(['jev', 'triage', 'job-weird', '--json'], env, { cwd: root })
  assert.equal(out.status, 0, out.stderr)
  const experimental = out.stderr.split('\n').filter((line) => EXPERIMENTAL_RE.test(line))
  assert.equal(experimental.length, 1, out.stderr)
  assert.match(experimental[0], /failure_kind/)
})

test('usage() contains the Experimental block', async (t) => {
  const root = scratch('exp-usage')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)

  const out = await run(['help'], env, { cwd: root })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /Experimental \(opt-in, not part of the standard loop\)/)
  assert.match(out.stdout, /start --jev-mcp/)
  assert.match(out.stdout, /wait --jev-watch/)
  assert.match(out.stdout, /jev triage/)
})
