import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))

/**
 * Two project directories and a private index. The job store follows the
 * caller's directory (no DSH_OFFLOAD_JOB_DIR), as it does for a real caller.
 */
function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-index-${name}-`))
  const starter = path.join(root, 'starter')
  const other = path.join(root, 'other')
  fs.mkdirSync(starter)
  fs.mkdirSync(other)
  const env = { ...process.env }
  delete env.DSH_OFFLOAD_JOB_DIR
  delete env.DSH_BRIDGE_PROJECT_ROOT
  delete env.DSH_OFFLOAD_REDIRECTED
  delete env.DEEPSEEK_MCP_DEFAULT_CWD
  Object.assign(env, {
    HOME: root,
    DSH_OFFLOAD_INDEX: path.join(root, 'index.jsonl'),
    DSH_HOME: path.join(root, 'dsh-home'),
    // No real Harness in a test: the worker's bridge child must exit at once.
    DSH_BIN: '/bin/false',
    DEEPSEEK_MCP_SKIP: 'deepseek',
    DEEPSEEK_WORKSPACE_ATTACH: '0',
  })
  return { root, starter, other, env }
}

function runner(args, cwd, env) {
  return spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', cwd, env, timeout: 60_000 })
}

function startJob(fx) {
  const out = runner(['start', 'index test task', '--cwd', fx.starter, '--json'], fx.starter, fx.env)
  assert.equal(out.status, 0, out.stderr)
  return JSON.parse(out.stdout).jobId
}

test('a job started in one directory is found from another one through the index', () => {
  const fx = fixture('found')
  const jobId = startJob(fx)
  assert.ok(fs.existsSync(path.join(fx.starter, 'scratch', 'dsh-offload', 'jobs', `${jobId}.json`)))
  assert.match(fs.readFileSync(fx.env.DSH_OFFLOAD_INDEX, 'utf8'), new RegExp(jobId))

  const status = runner(['status', jobId, '--json'], fx.other, fx.env)
  assert.equal(status.status, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).jobId, jobId)
  assert.match(status.stderr, /is stored in .*starter/)

  const waited = runner(['wait', jobId, '--timeout-ms', '30000'], fx.other, fx.env)
  assert.doesNotMatch(waited.stderr, /unknown job id/)
  // Nothing was written into the other directory's store.
  assert.equal(fs.existsSync(path.join(fx.other, 'scratch', 'dsh-offload', 'jobs', `${jobId}.json`)), false)
})

test('a job missing from the index is still found in a store the index knows', () => {
  const fx = fixture('known-store')
  const jobId = startJob(fx)
  // Simulate a job started before the index existed: drop its own line, keep another job's.
  const second = startJob(fx)
  const lines = fs.readFileSync(fx.env.DSH_OFFLOAD_INDEX, 'utf8').split('\n').filter((line) => line && !line.includes(jobId))
  fs.writeFileSync(fx.env.DSH_OFFLOAD_INDEX, `${lines.join('\n')}\n`)
  assert.match(lines.join('\n'), new RegExp(second))

  const status = runner(['status', jobId, '--json'], fx.other, fx.env)
  assert.equal(status.status, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).jobId, jobId)
})

for (const command of ['wait', 'status', 'result']) {
  test(`${command} on an unknown job id exits non-zero and names the store it searched`, () => {
    const fx = fixture(`unknown-${command}`)
    const out = runner([command, 'job-20990101-000000-dead'], fx.other, fx.env)
    assert.equal(out.status, 1)
    assert.match(out.stderr, /unknown job id: job-20990101-000000-dead: not in .*other/)
    assert.match(out.stderr, /DSH_OFFLOAD_JOB_DIR/)
  })
}
