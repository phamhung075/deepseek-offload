/**
 * `wait` without `--timeout-ms` blocks as long as the job itself may run, and a
 * wait that gives up while the job runs exits 2, also through the skill's
 * documented background-waiter pipeline. A job that runs 45 min once got a
 * waiter that gave up at a fixed 15 min, and the pipeline reported exit 0.
 *
 * Run: node --test tests/wait-deadline.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { jobSettleDeadline, WAIT_MARGIN_MS, WAIT_TIMED_OUT_EXIT } from '../.agents/skills/deepseek-offload/scripts/lib/wait-deadline.mjs'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))
const SKILL = fileURLToPath(new URL('../.agents/skills/deepseek-offload/SKILL.md', import.meta.url))
const MIN = 60_000
const BOUNDS = { defaultTimeoutMs: 15 * MIN }

test('a 45-minute job is waited on until its wall-clock bound, not a fixed 15', () => {
  const now = 1_000_000_000
  const deadline = jobSettleDeadline({ startedAt: now, timeoutMs: 45 * MIN }, now, BOUNDS)
  assert.ok(deadline - now > 45 * MIN)
  assert.equal(deadline - now, 45 * MIN + WAIT_MARGIN_MS)
})

test('a deferred job counts from its off-peak wake', () => {
  const now = 1_000_000_000
  const deadline = jobSettleDeadline({ startedAt: now, deferredUntil: now + 120 * MIN, timeoutMs: 45 * MIN }, now, BOUNDS)
  assert.equal(deadline, now + 120 * MIN + 45 * MIN + WAIT_MARGIN_MS)
})

test('a record without timeoutMs uses the default, and a late waiter still waits the margin', () => {
  const now = 1_000_000_000
  assert.equal(jobSettleDeadline({ startedAt: now }, now, BOUNDS), now + 15 * MIN + WAIT_MARGIN_MS)
  assert.equal(jobSettleDeadline({ startedAt: now - 10 * 60 * MIN, timeoutMs: MIN }, now, BOUNDS), now + WAIT_MARGIN_MS)
})

/** A job store holding one `running` job whose worker pid is a live process. */
function runningJob(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wait-'))
  fs.mkdirSync(path.join(root, 'jobs'))
  const worker = spawn('sleep', ['300'], { stdio: 'ignore' })
  t.after(() => worker.kill())
  const jobId = 'job-20261121-085722-b603'
  const record = { jobId, state: 'running', pid: worker.pid, startedAt: Date.now(), timeoutMs: 45 * MIN, cwd: root }
  fs.writeFileSync(path.join(root, 'jobs', `${jobId}.json`), JSON.stringify(record))
  const env = { ...process.env, DSH_OFFLOAD_JOB_DIR: root, DSH_OFFLOAD_INDEX: path.join(root, 'index.jsonl'), DSH_HOME: path.join(root, 'dsh-home') }
  return { root, jobId, env }
}

test('a wait that gives up while the job runs exits 2 and leaves the job running', (t) => {
  const { root, jobId, env } = runningJob(t)
  const out = spawnSync(process.execPath, [RUNNER, 'wait', jobId, '--timeout-ms', '1'], { encoding: 'utf8', cwd: root, env, timeout: 30_000 })
  assert.equal(out.status, WAIT_TIMED_OUT_EXIT, out.stderr)
  assert.match(out.stderr, /still running \(exit 2\)/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'jobs', `${jobId}.json`), 'utf8')).state, 'running')
})

test("the skill's background waiter exits with wait's code, not the pipeline's", (t) => {
  const { root, jobId, env } = runningJob(t)
  const doc = fs.readFileSync(SKILL, 'utf8')
  const lines = doc.split('\n')
  const first = lines.findIndex((line) => line.includes('dsh-offload.mjs wait <jobId1>'))
  assert.notEqual(first, -1, 'waiter pattern not found in SKILL.md')
  const waiter = `${lines[first]}\n${lines[first + 1]}`
    .replace('node .agents/skills/deepseek-offload/scripts/dsh-offload.mjs', `"${process.execPath}" "${RUNNER}"`)
    .replace('<jobId1>', `${jobId} --timeout-ms 1`)
  assert.doesNotMatch(waiter, /--timeout-ms \d{4,}/, 'the documented waiter must not cap the wait itself')
  const out = spawnSync('bash', ['-c', waiter], { encoding: 'utf8', cwd: root, env, timeout: 30_000 })
  assert.equal(out.status, WAIT_TIMED_OUT_EXIT, out.stdout + out.stderr)
  assert.match(out.stdout, /wait exit=2/)
})

test('wait without --timeout-ms on a 45-minute job waits until its own bound, not 15 minutes', async (t) => {
  const { root, jobId, env } = runningJob(t)
  const waiter = spawn(process.execPath, [RUNNER, 'wait', jobId], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => waiter.kill())
  let out = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no waiting line: ${out}`)), 20_000)
    waiter.stdout.on('data', (chunk) => {
      out += chunk
      if (/^waiting .*\n/m.test(out)) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  assert.match(out, /^waiting {3}for the job to settle, up to 4[67]m\d\ds .*then exit 2/m)
})
