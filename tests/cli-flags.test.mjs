/**
 * Flag-spec tests: unknown flags fail before a job is written, boolean flags do
 * not swallow the positional that follows them, value flags demand a value, and
 * every command accepts exactly the flags its spec declares.
 *
 * The CLI tests run the runner with `DSH_BIN=/bin/false`, so a started job's
 * bridge child exits at once: no real DeepSeek session is ever created. The
 * per-command acceptance table drives the parser directly and touches no job.
 *
 * Run: node --test tests/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMMAND_FLAGS,
  CliFlagError,
  parseArgs,
  specForCommand,
} from '../.agents/skills/deepseek-offload/scripts/lib/cli-flags.mjs'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))

/** A fresh job store and DSH home, so a test never touches the real ones. */
function scratch(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-flags-${name}-`))
  return {
    root,
    jobs: path.join(root, 'jobs'),
    env: {
      ...process.env,
      DSH_OFFLOAD_JOB_DIR: root,
      DSH_HOME: path.join(root, 'dsh-home'),
      // No real Harness in a test: the worker's bridge child must exit at once.
      DSH_BIN: '/bin/false',
      DEEPSEEK_MCP_SKIP: 'deepseek',
      DEEPSEEK_WORKSPACE_ATTACH: '0',
    },
  }
}

/** Run the runner CLI. */
function runner(args, env) {
  return spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', env })
}

/** Job records on disk, and an empty list when the directory was never created. */
function jobFiles(jobs) {
  return fs.existsSync(jobs) ? fs.readdirSync(jobs).filter((name) => name.endsWith('.json')) : []
}

test('an unknown flag on start fails before any job file is written', () => {
  const { root, jobs, env } = scratch('unknown')
  const out = runner(['start', 'task', '--not-a-flag'], env)
  assert.equal(out.status, 1)
  assert.match(out.stderr, /unknown flag --not-a-flag for `start` \(run `dsh-offload help`\)/)
  assert.deepEqual(jobFiles(jobs), [], 'no job is recorded for a rejected flag')
  fs.rmSync(root, { recursive: true, force: true })
})

test('--jev-review is rejected as an unknown flag', () => {
  const { root, jobs, env } = scratch('jev-review')
  const out = runner(['start', 'task', '--jev-review'], env)
  assert.equal(out.status, 1)
  assert.match(out.stderr, /unknown flag --jev-review for `start`/)
  assert.deepEqual(jobFiles(jobs), [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('a removed flag still gives the removed message, checked before unknown', () => {
  const { root, jobs, env } = scratch('removed')
  const out = runner(['start', 'task', '--jev-mcp'], env)
  assert.equal(out.status, 1)
  assert.match(out.stderr, /--jev-mcp was removed and is no longer supported/)
  assert.doesNotMatch(out.stderr, /unknown flag/)
  assert.deepEqual(jobFiles(jobs), [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('a boolean flag does not swallow the positional that follows it', () => {
  const { root, env } = scratch('readonly-prompt')
  const out = runner(['start', '--read-only', 'task', '--detach', '--json'], env)
  assert.equal(out.status, 0, out.stderr)

  const job = JSON.parse(out.stdout)
  assert.equal(job.readOnly, true, '--read-only stays a boolean')
  assert.equal(job.prompt, 'task', 'the positional survives as the prompt')

  assert.equal(runner(['cancel', job.jobId], env).status, 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a value flag without a value fails and records no job', () => {
  const { root, jobs, env } = scratch('missing-value')
  const out = runner(['start', 'task', '--timeout-ms'], env)
  assert.equal(out.status, 1)
  assert.match(out.stderr, /--timeout-ms requires a value/)
  assert.deepEqual(jobFiles(jobs), [])

  // A following flag is not a value either.
  const followed = runner(['start', 'task', '--timeout-ms', '--json'], env)
  assert.equal(followed.status, 1)
  assert.match(followed.stderr, /--timeout-ms requires a value/)
  assert.deepEqual(jobFiles(jobs), [])

  fs.rmSync(root, { recursive: true, force: true })
})

test('--timeout-ms=5000 and --timeout-ms 5000 both reach the job record', () => {
  for (const flag of [['--timeout-ms=5000'], ['--timeout-ms', '5000']]) {
    const { root, env } = scratch('timeout')
    const out = runner(['start', 'task', ...flag, '--detach', '--json'], env)
    assert.equal(out.status, 0, out.stderr)
    const job = JSON.parse(out.stdout)
    assert.equal(job.timeoutMs, 5000)
    assert.equal(runner(['cancel', job.jobId], env).status, 0)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('every command accepts its declared boolean and value flags', () => {
  for (const [key, spec] of Object.entries(COMMAND_FLAGS)) {
    assert.equal(spec.name, key, `${key} names itself in the spec`)
    for (const flag of spec.boolean) {
      const { flags } = parseArgs([`--${flag}`], spec)
      assert.equal(flags[flag], true, `${key} accepts --${flag}`)
    }
    for (const flag of spec.value) {
      const { flags } = parseArgs([`--${flag}`, 'sentinel'], spec)
      assert.equal(flags[flag], 'sentinel', `${key} accepts --${flag} VALUE`)
      const inline = parseArgs([`--${flag}=sentinel`], spec)
      assert.equal(inline.flags[flag], 'sentinel', `${key} accepts --${flag}=VALUE`)
    }
  }
})

test('every command rejects a flag outside its spec with the unknown-flag error', () => {
  for (const spec of Object.values(COMMAND_FLAGS)) {
    assert.throws(
      () => parseArgs(['--totally-unknown'], spec),
      (error) => error instanceof CliFlagError
        && error.message === `unknown flag --totally-unknown for \`${spec.name}\` (run \`dsh-offload help\`)`,
    )
  }
})

test('a boolean flag takes no inline value', () => {
  assert.throws(
    () => parseArgs(['--read-only=true'], specForCommand('start')),
    /flag --read-only is a boolean and does not take a value/,
  )
})

test('the internal __run mode still parses the bare job id the launcher passes', () => {
  const { positional, flags } = parseArgs(['job-20260101-000000-dead'], specForCommand('__run'))
  assert.deepEqual(positional, ['job-20260101-000000-dead'])
  assert.deepEqual(flags, {})
})
