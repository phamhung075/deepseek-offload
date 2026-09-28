import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))

/** A fresh job store and DSH home, so a test never touches the real ones. */
function scratch(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-readonly-${name}-`))
  return {
    root,
    env: {
      ...process.env,
      DSH_OFFLOAD_JOB_DIR: root,
      DSH_HOME: path.join(root, 'dsh-home'),
      // No real Harness in a test: the worker's bridge child must exit at once.
      DSH_BIN: '/bin/false',
      DEEPSEEK_MCP_SKIP: 'deepseek',
    },
  }
}

/** Run the runner CLI. */
function runner(args, env) {
  return spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', env })
}

test('--read-only and --allow-git-write are rejected together', () => {
  const { root, env } = scratch('conflict')
  const out = runner(['start', 'investigate the parser', '--read-only', '--allow-git-write'], env)
  assert.equal(out.status, 1)
  assert.match(out.stderr, /contradict each other/)
  assert.deepEqual(fs.readdirSync(path.join(root, 'jobs')), [], 'no job is recorded for a rejected start')
})

test('--read-only is recorded on the job, so the worker runs the job guarded', () => {
  const { root, env } = scratch('record')
  const out = runner(['start', 'investigate the parser', '--read-only', '--detach', '--json'], env)
  assert.equal(out.status, 0, out.stderr)

  const job = JSON.parse(out.stdout)
  assert.equal(job.readOnly, true)
  assert.equal(job.allowGitWrite, false)

  const stored = JSON.parse(fs.readFileSync(path.join(root, 'jobs', `${job.jobId}.json`), 'utf8'))
  assert.equal(stored.readOnly, true)

  // The detached worker cannot reach a Harness in this environment, so stop it
  // rather than leaving it to settle on its own; cancel is idempotent.
  assert.equal(runner(['cancel', job.jobId], env).status, 0)
})

test('a plain start records neither read-only nor git writes', () => {
  const { root, env } = scratch('plain')
  const out = runner(['start', 'investigate the parser', '--detach', '--json'], env)
  assert.equal(out.status, 0, out.stderr)
  const job = JSON.parse(out.stdout)
  assert.equal(job.readOnly, false)
  assert.equal(job.allowGitWrite, false)
  assert.equal(runner(['cancel', job.jobId], env).status, 0)
  void root
})
