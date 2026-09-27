/**
 * Jev hardening: code-enforced hard rules, claim checking, the decision log,
 * failure triage, and the early-return `wait --jev-watch`.
 *
 * Every API test points `TYPESAFE_API_URL` at a local stub and never calls the
 * real API; the runner is spawned asynchronously because the stub lives in this
 * process. Pure helpers (glob, citation extraction, the triage table) are
 * imported directly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { globMatch, extractNamedPaths, isTestSibling, isUnderNamedPath } from '../.agents/skills/deepseek-offload/scripts/jev/rules.mjs'
import { extractClaims } from '../.agents/skills/deepseek-offload/scripts/jev/claims.mjs'
import { TRIAGE_RULES, matchRule } from '../.agents/skills/deepseek-offload/scripts/jev/triage.mjs'
import { summarizeLog, minPNone } from '../.agents/skills/deepseek-offload/scripts/jev/decide.mjs'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))
const SECRET_KEY = 'sk-test-SECRET-KEY-hardening'

function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-jev-hard-${name}-`))
}

// ---------------------------------------------------------------- pure units

test('glob matcher: **, *, ? and basenames', () => {
  assert.equal(globMatch('**', 'a/b/c.txt'), true)
  assert.equal(globMatch('src/**', 'src/a/b.ts'), true)
  assert.equal(globMatch('src/**', 'other/a.ts'), false)
  assert.equal(globMatch('src/*.ts', 'src/a.ts'), true)
  assert.equal(globMatch('src/*.ts', 'src/deep/a.ts'), false)
  assert.equal(globMatch('**/*.gen.ts', 'foo.gen.ts'), true)
  assert.equal(globMatch('**/*.gen.ts', 'a/b/foo.gen.ts'), true)
  assert.equal(globMatch('a?.ts', 'ab.ts'), true)
  assert.equal(globMatch('a?.ts', 'a/b.ts'), false)
  assert.equal(globMatch('*.pem', 'config/secrets/key.pem'), true, 'a slash-free glob matches the basename')
  assert.equal(globMatch('key.pem', 'a/key.pem'), true)
  assert.equal(globMatch('key.pem', 'a/key.pem.bak'), false)
})

test('named-path extraction strips citations, backticks, punctuation and absolutises', () => {
  const named = extractNamedPaths(
    'Change `server-go/internal/auth/keycloak.go:42`, then a.txt; also ~:3 and /work/repo/lib/x.go.',
    '/work/repo',
  ).map((entry) => entry.value)
  assert.deepEqual(named, ['server-go/internal/auth/keycloak.go', 'a.txt', 'lib/x.go'])
  assert.equal(extractNamedPaths('just prose with no paths', '/work/repo').length, 0)
  assert.equal(isTestSibling('pkg/a_test.go'), true)
  assert.equal(isTestSibling('pkg/a.test.ts'), true)
  assert.equal(isTestSibling('tests/helper.go'), true)
  assert.equal(isTestSibling('pkg/a.go'), false)
})

test('named-path extraction keeps dot-directories, drops bare dots, and scopes bare file names', () => {
  const workOrder = 'Docs only: README.md, INSTALL.md, .agents/skills/deepseek-offload/SKILL.md, a NEW .agents/mcp-jev/README.md, and usage() in dsh-offload.mjs or scripts/jev/cli.mjs'
  const named = extractNamedPaths(workOrder, process.cwd())
  assert.deepEqual(named.map((entry) => entry.value).sort(), [
    '.agents/mcp-jev/README.md',
    '.agents/skills/deepseek-offload/SKILL.md',
    'INSTALL.md',
    'README.md',
    'dsh-offload.mjs',
    'scripts/jev/cli.mjs',
  ].sort())

  const bare = extractNamedPaths('touch dsh-offload.mjs only', process.cwd())
  assert.equal(isUnderNamedPath('.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', bare), true, 'a bare file name matches its basename at any depth')
  assert.equal(isUnderNamedPath('scripts/jev/cli.mjs', named), true, 'a named path with a slash keeps prefix semantics')
  assert.equal(isUnderNamedPath('docs/other.md', named), false)

  assert.deepEqual(
    extractNamedPaths('ignore .. and ... but keep ./notes.md and .env here', process.cwd()).map((entry) => entry.value),
    ['notes.md', '.env'],
  )
})

test('citation extraction handles path:line, path:~line and path:line-line', () => {
  const claims = extractClaims(
    'The guard is in server-go/a.go:12 and blocks writes. Another `x/y.py:~7` note. Range lib/z.ts:3-9 done.',
  )
  assert.equal(claims.length, 3)
  assert.deepEqual([claims[0].path, claims[0].line, claims[0].endLine], ['server-go/a.go', 12, null])
  assert.equal(claims[0].sentence, 'The guard is in server-go/a.go:12 and blocks writes.')
  assert.deepEqual([claims[1].path, claims[1].line], ['x/y.py', 7])
  assert.deepEqual([claims[2].path, claims[2].line, claims[2].endLine], ['lib/z.ts', 3, 9])
})

test('triage rule table matches every named pattern without a key', () => {
  const samples = [
    ['worker process 4242 is gone; see worker.log', 'interrupted'],
    ['ACP request timed out after 900000ms', 'timeout'],
    ['EROFS: read-only file system', 'environment'],
    ['EACCES: permission denied, open /x', 'environment'],
    ['HTTP 401 Unauthorized', 'credentials'],
    ['HTTP 403 Forbidden', 'credentials'],
    ['getaddrinfo ENOTFOUND api.example.com', 'network'],
    ['connect ECONNREFUSED 127.0.0.1:1', 'network'],
    ['request ETIMEDOUT', 'network'],
  ]
  assert.equal(TRIAGE_RULES.length, 5)
  for (const [text, kind] of samples) {
    assert.equal(matchRule(text)?.kind, kind, `${text} -> ${kind}`)
  }
  assert.equal(matchRule('the agent wrote the wrong function'), null)
})

test('log summariser counts agreement and answers the P(none) what-if', () => {
  const entries = [
    { decision: 'reject', review: { state: 'flagged', pNoneMin: 0.2 } },
    { decision: 'accept', review: { state: 'clean', pNoneMin: 0.9 } },
    { decision: 'accept', review: { state: 'clean', pNoneMin: 0.45 } },
    { decision: 'partial', review: { state: 'flagged', pNoneMin: 0.4 } },
  ]
  const summary = summarizeLog(entries)
  assert.deepEqual(summary.byDecision, { accept: 2, reject: 1, partial: 1 })
  assert.equal(summary.agreement.flaggedRejected, 1)
  assert.equal(summary.agreement.cleanAccepted, 2)
  const at05 = summary.whatIf.find((row) => row.threshold === 0.5)
  assert.equal(at05.flaggedRejected, 1)
  assert.equal(at05.flaggedAccepted, 1, 'the 0.45-clean accept flips to flagged at 0.5')
  assert.equal(at05.cleanAccepted, 1)
  assert.equal(minPNone({ groups: [{ pNone: 0.7 }, { pNone: 0.3 }] }), 0.3)
  assert.equal(minPNone({ groups: [] }), null)
})

// ------------------------------------------------------------- integration

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
  if (questions.supported) answers.supported = { noul: 0.9 }
  if (questions.progress) answers.progress = { choice: 'progressing', confidence: 0.9, probabilities: { progressing: 0.9 } }
  if (questions.failure_kind) answers.failure_kind = { choice: 'input', confidence: 0.8, probabilities: { input: 0.8 } }
  return { model: 'jev-test', answers, usage: {} }
}

function baseEnv(root, url, { key = SECRET_KEY } = {}) {
  const env = { ...process.env }
  delete env.TYPESAFE_API_KEY
  delete env.TYPESAFE_AI_API
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

const FIXTURE_GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

/** A repo with a base commit and a second commit that rewrites `changeFiles`. */
function makeRepo(root, baseFiles, changeFiles) {
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: FIXTURE_GIT_ENV })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  for (const [name, text] of Object.entries(baseFiles)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
    fs.writeFileSync(path.join(repo, name), text)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD').stdout.trim()
  for (const [name, text] of Object.entries(changeFiles)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
    fs.writeFileSync(path.join(repo, name), text)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'change')
  const head = git('rev-parse', 'HEAD').stdout.trim()
  return { repo, base, head }
}

function writeJob(root, record) {
  const jobsDir = path.join(root, 'jobs')
  fs.mkdirSync(jobsDir, { recursive: true })
  fs.writeFileSync(path.join(jobsDir, `${record.jobId}.json`), `${JSON.stringify(record, null, 2)}\n`)
  return jobsDir
}

function writeConfig(root, config) {
  const file = path.join(root, 'jev.json')
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config))
  return file
}

test('neverTouch flags the review with zero Jev calls for the rule', async (t) => {
  const root = scratch('nevertouch')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const { repo, base, head } = makeRepo(root, { 'README.md': 'base\n' }, { 'secrets/key.pem': 'PRIVATE\n' })
  const config = writeConfig(root, { neverTouch: ['secrets/**'] })
  env.DSH_OFFLOAD_JEV_CONFIG = config
  const promptFile = path.join(root, 'prompt.md')
  fs.writeFileSync(promptFile, 'Add secrets/key.pem handling and report.\n')

  const out = await run(['jev', 'review', '--prompt-file', promptFile, '--repo', repo, '--base', base, '--head', head], env)
  assert.equal(out.status, 3, out.stderr)
  assert.match(out.stdout, /never-touch path/)
  assert.equal(stub.requests.length, 0, 'a flagging rule skips Jev entirely')
})

test('pathScope warns (Jev runs) but flags (Jev skipped) per config', async (t) => {
  const root = scratch('pathscope')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const { repo, base, head } = makeRepo(root, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, { 'a.txt': 'a2\n', 'b.txt': 'b2\n' })
  const promptFile = path.join(root, 'prompt.md')
  fs.writeFileSync(promptFile, 'Change a.txt and report the result as text.\n')

  const warnConfig = writeConfig(root, { pathScope: 'warn' })
  env.DSH_OFFLOAD_JEV_CONFIG = warnConfig
  const warn = await run(['jev', 'review', '--prompt-file', promptFile, '--repo', repo, '--base', base, '--head', head], env)
  assert.equal(warn.status, 0, warn.stderr)
  assert.match(warn.stdout, /outside paths named in the work order/)
  assert.ok(stub.requests.length > 0, 'a warn finding does not stop the Jev call')

  stub.requests.length = 0
  const flagConfig = writeConfig(root, { pathScope: 'flag' })
  env.DSH_OFFLOAD_JEV_CONFIG = flagConfig
  const flag = await run(['jev', 'review', '--prompt-file', promptFile, '--repo', repo, '--base', base, '--head', head], env)
  assert.equal(flag.status, 3, flag.stderr)
  assert.match(flag.stdout, /outside paths named in the work order/)
  assert.equal(stub.requests.length, 0, 'a flagging pathScope skips Jev')
})

test('a bad config warns once and the review still runs', async (t) => {
  const root = scratch('badconfig')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const { repo, base, head } = makeRepo(root, { 'a.txt': 'a\n' }, { 'a.txt': 'a2\n' })
  const config = writeConfig(root, '{ this is not json')
  env.DSH_OFFLOAD_JEV_CONFIG = config
  const promptFile = path.join(root, 'prompt.md')
  fs.writeFileSync(promptFile, 'Change a.txt and report.\n')

  const out = await run(['jev', 'review', '--prompt-file', promptFile, '--repo', repo, '--base', base, '--head', head], env)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stderr, /not valid JSON/)
  assert.ok(stub.requests.length > 0, 'the review still ran with the default config')
})

test('claims cite evidence at REV and list only unsupported claims', async (t) => {
  const root = scratch('claims')
  const { repo, base, head } = makeRepo(
    root,
    { 'lib/x.go': `${Array.from({ length: 20 }, (_v, i) => (i === 4 ? '// old guard' : `line ${i + 1}`)).join('\n')}\n` },
    { 'lib/x.go': `${Array.from({ length: 20 }, (_v, i) => (i === 4 ? '// new guard' : `line ${i + 1}`)).join('\n')}\n` },
  )
  let supported = 0.1
  const stub = await startStub((parsed) => {
    if (!parsed?.questions?.supported) return null
    return { payload: { model: 'jev-test', answers: { supported: { noul: supported } }, usage: {} } }
  })
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const jobId = 'job-claims'
  const jobsDir = writeJob(root, { jobId, state: 'done', prompt: 'claim check', reviewRepo: repo })
  fs.writeFileSync(path.join(jobsDir, `${jobId}.result.md`), 'The guard is implemented in lib/x.go:5 and blocks writes.\n')

  const flagged = await run(['jev', 'claims', jobId, '--repo', repo, '--json'], env)
  assert.equal(flagged.status, 0, flagged.stderr)
  const report = JSON.parse(flagged.stdout)
  assert.equal(report.considered, 1)
  assert.equal(report.unsupportedCount, 1)
  assert.equal(report.unsupported[0].path, 'lib/x.go')
  assert.equal(report.unsupported[0].line, 5)
  const headEvidence = stub.requests.at(-1).state.evidence.lines
  assert.match(headEvidence, /5: \/\/ new guard/, 'the default REV is the reviewed head')

  // --rev reads the older commit instead.
  const atBase = await run(['jev', 'claims', jobId, '--repo', repo, '--rev', base, '--json'], env)
  assert.equal(atBase.status, 0, atBase.stderr)
  assert.match(stub.requests.at(-1).state.evidence.lines, /5: \/\/ old guard/)

  supported = 0.9
  const clean = await run(['jev', 'claims', jobId, '--repo', repo, '--json'], env)
  assert.equal(clean.status, 0, clean.stderr)
  assert.equal(JSON.parse(clean.stdout).unsupportedCount, 0, '0.9 is above the 0.3 threshold')
  assert.equal(head.length > 0, true)
})

test('decide writes a label and log reports counts and the what-if', async (t) => {
  const root = scratch('decide')
  const env = baseEnv(root, 'http://127.0.0.1:1/v1/systemone', { key: null })
  const jobsDir = writeJob(root, { jobId: 'job-flagged', state: 'done', label: 'fix-auth', prompt: 'x' })
  writeJob(root, { jobId: 'job-clean', state: 'done', label: 'fix-ui', prompt: 'y' })
  fs.writeFileSync(path.join(jobsDir, 'job-flagged.jev-review.json'), JSON.stringify({ groups: [{ pNone: 0.2 }] }))
  fs.writeFileSync(path.join(jobsDir, 'job-clean.jev-review.json'), JSON.stringify({ groups: [{ pNone: 0.9 }] }))
  fs.writeFileSync(path.join(jobsDir, 'job-flagged.json'), JSON.stringify({ jobId: 'job-flagged', state: 'done', label: 'fix-auth', jevReview: { state: 'flagged', flaggedGroups: 1 } }))

  const accept = await run(['jev', 'decide', 'job-flagged', 'accept', '--note', 'looks fine'], env)
  assert.equal(accept.status, 0, accept.stderr)
  const decision = JSON.parse(fs.readFileSync(path.join(jobsDir, 'job-flagged.jev-decision.json'), 'utf8'))
  assert.equal(decision.decision, 'accept')
  assert.equal(decision.label, 'fix-auth')
  assert.equal(decision.note, 'looks fine')
  assert.equal(decision.review.state, 'flagged')
  assert.equal(decision.review.pNoneMin, 0.2)

  assert.equal((await run(['jev', 'decide', 'job-clean', 'reject'], env)).status, 0)

  const log = await run(['jev', 'log'], env)
  assert.equal(log.status, 0, log.stderr)
  assert.match(log.stdout, /accept 1, reject 1, partial 0/)
  assert.match(log.stdout, /flagged&accepted 1/)
  assert.match(log.stdout, /clean&rejected 1/)
  assert.match(log.stdout, /< 0\.5:/)
  const lines = fs.readFileSync(path.join(jobsDir, 'jev-log.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2, 'one JSONL line per decision')
})

test('auto-review checks a settled job\'s claims and lists them in the block', async (t) => {
  const root = scratch('autoclaims')
  const { repo, base } = makeRepo(
    root,
    { 'lib/x.go': `${Array.from({ length: 20 }, (_v, i) => (i === 4 ? '// old guard' : `line ${i + 1}`)).join('\n')}\n` },
    { 'lib/x.go': `${Array.from({ length: 20 }, (_v, i) => (i === 4 ? '// new guard' : `line ${i + 1}`)).join('\n')}\n` },
  )
  const stub = await startStub((parsed) => {
    if (!parsed?.questions?.supported) return null
    return { payload: { model: 'jev-test', answers: { supported: { noul: 0.1 } }, usage: {} } }
  })
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const jobId = 'job-autoclaims'
  const jobsDir = writeJob(root, {
    jobId,
    state: 'done',
    prompt: 'touch lib/x.go and report',
    reviewRepo: repo,
    reviewBase: base,
    startedAt: Date.now() - 5000,
    finishedAt: Date.now() - 1000,
  })
  fs.writeFileSync(path.join(jobsDir, `${jobId}.result.md`), 'The guard is at lib/x.go:5 and blocks writes.\n')

  const out = await run(['result', jobId], env)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /claims to verify/)
  assert.match(out.stdout, /lib\/x\.go:5/)
  const job = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.json`), 'utf8'))
  assert.equal(job.jevReview.claimsFlagged, true)
  assert.equal(job.jevReview.state, 'clean', 'claims never flag the diff review')
})

test('triage uses the rule table without a key and one failure_kind with a key', async (t) => {
  const root = scratch('triage')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  writeJob(root, { jobId: 'job-gone', state: 'error', error: 'worker process 99 is gone' })
  writeJob(root, { jobId: 'job-weird', state: 'error', error: 'the flux capacitor inverted' })

  const tailStub = path.join(root, 'tail-stub.mjs')
  fs.writeFileSync(tailStub, "process.stdout.write('12:00:00  tool bash: echo hi\\n')\n")
  env.DSH_OFFLOAD_SESSION_TAIL = tailStub

  const gone = await run(['jev', 'triage', 'job-gone'], env)
  assert.equal(gone.status, 0, gone.stderr)
  assert.match(gone.stdout, /kind    interrupted/)
  assert.match(gone.stdout, /source  rule/)
  assert.match(gone.stdout, /dsh-offload resume job-gone/)
  assert.equal(stub.requests.length, 0, 'a matched rule never calls Jev')

  const weird = await run(['jev', 'triage', 'job-weird', '--json'], env)
  assert.equal(weird.status, 0, weird.stderr)
  const result = JSON.parse(weird.stdout)
  assert.equal(result.kind, 'input')
  assert.equal(result.source, 'jev')
  assert.equal(result.unvalidated, true)
  assert.equal(stub.requests.length, 1, 'exactly one failure_kind request')
  assert.ok(stub.requests[0].questions.failure_kind)
})

test('a failed result prints the triage block from a code rule', async (t) => {
  const root = scratch('result-triage')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url, { key: null })
  writeJob(root, { jobId: 'job-dead', state: 'error', error: 'worker process 777 is gone', startedAt: Date.now() - 1000 })

  const out = await run(['result', 'job-dead'], env)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /--- failure triage/)
  assert.match(out.stdout, /kind    interrupted/)
  assert.match(out.stdout, /dsh-offload resume job-dead/)
  assert.equal(stub.requests.length, 0)
})

test('wait --jev-watch returns 4 on a looping verdict while the job keeps running', async (t) => {
  const root = scratch('waitwatch')
  const stub = await startStub((parsed) => {
    if (!parsed?.questions?.progress) return null
    return { payload: { model: 'jev-test', answers: { progress: { choice: 'looping', confidence: 0.9, probabilities: { looping: 0.9 } } }, usage: {} } }
  })
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const jobsDir = writeJob(root, { jobId: 'job-loop', state: 'running', prompt: 'change a.txt and report', startedAt: Date.now() - 1000 })
  const tailStub = path.join(root, 'tail-stub.mjs')
  fs.writeFileSync(tailStub, "process.stdout.write('12:00:00  tool bash: echo same\\n12:00:01  tool bash: echo same\\n')\n")
  env.DSH_OFFLOAD_SESSION_TAIL = tailStub

  const out = await run(['wait', 'job-loop', '--jev-watch', '--watch-interval-ms', '10', '--timeout-ms', '30000'], env)
  assert.equal(out.status, 4, out.stderr)
  assert.match(out.stdout, /looping/)
  assert.match(out.stdout, /last activity:/)
  assert.match(out.stdout, /dsh-offload update job-loop/)
  const still = JSON.parse(fs.readFileSync(path.join(jobsDir, 'job-loop.json'), 'utf8'))
  assert.equal(still.state, 'running', 'the job keeps running')
  assert.ok(stub.requests.length > 0)
})

test('wait --jev-watch returns normally when the job is already settled', async (t) => {
  const root = scratch('waitdone')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  writeJob(root, { jobId: 'job-done', state: 'done', prompt: 'finished', startedAt: Date.now() - 1000, finishedAt: Date.now() })

  const out = await run(['wait', 'job-done', '--jev-watch', '--watch-interval-ms', '10'], env)
  assert.equal(out.status, 0, out.stderr)
  assert.equal(stub.requests.length, 0, 'a settled job is never probed')
})
