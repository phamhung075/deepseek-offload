/**
 * The working-tree review group, the self-checkout `reviewScope` guard, and
 * claims on an empty diff.
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
  gitIn,
  makeRepo,
  makeCleanRepo,
  makePeerRepo,
  writeJob,
  readJob,
  allHunkFiles,
  writePrompt,
  scratch,
} from './helpers/jev-worktree-fixture.mjs'

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

// ---------------------------------------------------------------------------
// Item 2: the self-checkout guard and reviewScope
// ---------------------------------------------------------------------------

test('reviewRepo equal to the job cwd warns and records reviewScope uncommitted', async (t) => {
  const root = scratch('selfcheckout')
  const { repo } = makeRepo(root)
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)

  const started = await run(['start', 'change a.txt and report', '--cwd', repo, '--review-repo', repo, '--detach', '--json'], env, { cwd: root })
  assert.equal(started.status, 0, started.stderr)
  assert.match(started.stderr, /review repo is the checkout this job starts from/)
  assert.match(started.stderr, /use a clone for commit review/)
  const job = JSON.parse(started.stdout)
  assert.equal(job.reviewScope, 'uncommitted')
  assert.equal(readJob(root, job.jobId).reviewScope, 'uncommitted')
  await run(['cancel', job.jobId], env, { cwd: root })
})

test('a review repo that is not the job cwd keeps reviewScope all and warns not at all', async (t) => {
  const root = scratch('clone')
  const { repo } = makeRepo(root)
  const peer = makePeerRepo(root)
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)

  const started = await run(['start', 'change a.txt and report', '--cwd', peer.repo, '--review-repo', repo, '--detach', '--json'], env, { cwd: root })
  assert.equal(started.status, 0, started.stderr)
  assert.doesNotMatch(started.stderr, /this job starts from/)
  const job = JSON.parse(started.stdout)
  assert.equal(job.reviewScope, 'all')
  await run(['cancel', job.jobId], env, { cwd: root })
})

test('resume copies reviewScope from the resumed job', async (t) => {
  const root = scratch('resume-scope')
  const { repo, base } = makeRepo(root)
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  writeJob(root, {
    jobId: 'job-uncommitted',
    state: 'done',
    prompt: 'original task',
    cwd: repo,
    permission: 'allow',
    allowGitWrite: false,
    readOnly: false,
    sessionId: 'session-scope',
    reviewRepo: repo,
    reviewBase: base,
    reviewScope: 'uncommitted',
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now() - 30_000,
  })

  const resumed = await run(['resume', 'job-uncommitted', '--json'], env, { cwd: root })
  assert.equal(resumed.status, 0, resumed.stderr)
  const job = JSON.parse(resumed.stdout)
  assert.equal(job.reviewRepo, repo)
  assert.equal(job.reviewScope, 'uncommitted')
  await run(['cancel', job.jobId], env, { cwd: root })
})

test('reviewScope uncommitted skips a job-time commit but reviews the uncommitted change', async (t) => {
  const root = scratch('scope-review')
  const { repo, base } = makeRepo(root)
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const jobId = 'job-scope-review'
  const jobsDir = writeJob(root, {
    jobId,
    state: 'done',
    prompt: 'change b.txt and report',
    cwd: repo,
    reviewRepo: repo,
    reviewBase: base,
    reviewScope: 'uncommitted',
    startedAt: Date.now() - 5000,
    finishedAt: Date.now() - 1000,
  })
  fs.writeFileSync(path.join(jobsDir, `${jobId}.result.md`), 'changed b.txt\n')
  // A commit that lands during the job (the orchestrator's, in the real case).
  fs.writeFileSync(path.join(repo, 'c.txt'), 'charlie committed\n')
  gitIn(repo, 'add', 'c.txt')
  gitIn(repo, 'commit', '-q', '-m', 'orchestrator commit')
  // The worker's uncommitted change.
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bravo uncommitted\n')

  const out = await run(['result', jobId], env, { cwd: root })
  assert.equal(out.status, 0, out.stderr)
  const report = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.jev-review.json`), 'utf8'))
  assert.equal(report.scope, 'uncommitted')
  const kinds = report.groups.map((group) => group.kind)
  assert.deepEqual(kinds, ['worktree'], out.stdout)
  assert.deepEqual(report.groups[0].hunks.map((hunk) => hunk.file), ['b.txt'])
  assert.ok(!allHunkFiles(stub.requests).includes('c.txt'), 'the orchestrator commit is not reviewed')
})

// ---------------------------------------------------------------------------
// Item 3: claims on an empty diff
// ---------------------------------------------------------------------------

test('an empty diff still checks and shows the result text claims', async (t) => {
  const root = scratch('empty-claims')
  const { repo, base } = makeCleanRepo(root)
  const stub = await startStub((parsed) => {
    if (!parsed?.questions?.supported) return null
    return { payload: { model: 'jev-test', answers: { supported: { noul: 0.1 } }, usage: {} } }
  })
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const jobId = 'job-empty-claims'
  const jobsDir = writeJob(root, {
    jobId,
    state: 'done',
    prompt: 'report only',
    cwd: repo,
    reviewRepo: repo,
    reviewBase: base,
    reviewScope: 'all',
    startedAt: Date.now() - 5000,
    finishedAt: Date.now() - 1000,
  })
  fs.writeFileSync(path.join(jobsDir, `${jobId}.result.md`), 'The file a.txt:1 holds the alpha value.\n')

  const out = await run(['result', jobId], env, { cwd: root })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /no changes in the review range/)
  assert.match(out.stdout, /claims to verify \(1\/1 unsupported/)
  assert.match(out.stdout, /a\.txt:1\s+supported=0\.100/)
  const claimRequests = stub.requests.filter((body) => body?.questions?.supported)
  assert.equal(claimRequests.length, 1, 'exactly one claims request reached the stub')
  const job = readJob(root, jobId)
  assert.equal(job.jevReview.state, 'empty')
  assert.equal(job.jevReview.claimsFlagged, true)
  assert.equal(job.jevReview.claimsConsidered, 1)
  assert.equal(job.jevReview.claimsUnsupported, 1)
})
