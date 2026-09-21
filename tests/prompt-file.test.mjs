/**
 * Prompt delivery tests: `--prompt-file` / `-f` and the `-` stdin sentinel.
 *
 * The point of these flags is to keep a multi-line prompt — one carrying
 * backticks or code fences — out of the shell, which would otherwise evaluate
 * the backtick spans as command substitution before the runner ever sees the
 * text. These tests pin that the prompt arrives verbatim, that a missing file
 * fails loudly, and that the `deepseek-offload.mjs` alias runs the same runner.
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

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))
const ALIAS = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/deepseek-offload.mjs', import.meta.url))

/** A fresh job store and DSH home, so a test never touches the real ones. */
function scratch(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-prompt-${name}-`))
  return {
    root,
    env: {
      ...process.env,
      DSH_OFFLOAD_JOB_DIR: root,
      DSH_HOME: path.join(root, 'dsh-home'),
      // No real Harness in a test: the bridge's ACP child must exit at once.
      DSH_BIN: '/bin/false',
      DEEPSEEK_MCP_SKIP: 'deepseek',
      DEEPSEEK_WORKSPACE_ATTACH: '0',
    },
  }
}

/** Run one runner CLI invocation. */
function runner(args, env, { input, executable = RUNNER } = {}) {
  const options = { encoding: 'utf8', env }
  if (input !== undefined) options.input = input
  return spawnSync(process.execPath, [executable, ...args], options)
}

/** A prompt file inside `root`, written verbatim. */
function promptFile(root, text) {
  const file = path.join(root, 'prompt.md')
  fs.writeFileSync(file, text)
  return file
}

test('--prompt-file loads the prompt verbatim on the job record', () => {
  const { root, env } = scratch('long')
  const text = 'Review the pipeline\n\n```sh\necho `whoami`\n```\nkeep every backtick'
  const file = promptFile(root, `${text}\n`)

  const out = runner(['start', '--prompt-file', file, '--detach', '--json'], env)
  assert.equal(out.status, 0, out.stderr)

  const job = JSON.parse(out.stdout)
  assert.equal(job.prompt, text, 'the file content is stored byte for byte, minus the trailing newline')

  assert.equal(runner(['cancel', job.jobId], env).status, 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('-f is the short form of --prompt-file', () => {
  const { root, env } = scratch('short')
  const text = 'A short delegation prompt.'
  const file = promptFile(root, text)

  const out = runner(['start', '-f', file, '--detach', '--json'], env)
  assert.equal(out.status, 0, out.stderr)
  const job = JSON.parse(out.stdout)
  assert.equal(job.prompt, text)

  assert.equal(runner(['cancel', job.jobId], env).status, 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('`-` reads the prompt from stdin', () => {
  const { root, env } = scratch('stdin')
  const text = 'stdin job line one\nline two'

  const out = runner(['start', '-', '--detach', '--json'], env, { input: `${text}\n` })
  assert.equal(out.status, 0, out.stderr)
  const job = JSON.parse(out.stdout)
  assert.equal(job.prompt, text)

  assert.equal(runner(['cancel', job.jobId], env).status, 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a missing prompt file fails with exit code 1 and records no job', () => {
  const { root, env } = scratch('missing')
  const missing = path.join(root, 'does-not-exist.md')

  const out = runner(['start', '--prompt-file', missing], env)
  assert.equal(out.status, 1)
  assert.match(out.stderr, new RegExp(`prompt file not found: ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.deepEqual(fs.readdirSync(path.join(root, 'jobs')), [], 'no job is recorded for a rejected start')

  fs.rmSync(root, { recursive: true, force: true })
})

test('the deepseek-offload.mjs alias runs the same runner', () => {
  const { root, env } = scratch('alias')
  const text = 'Alias-invoked prompt.'
  const file = promptFile(root, text)

  const out = runner(['start', '--prompt-file', file, '--detach', '--json'], env, { executable: ALIAS })
  assert.equal(out.status, 0, out.stderr)
  const job = JSON.parse(out.stdout)
  assert.equal(job.prompt, text)
  assert.equal(job.bridge.endsWith(path.join('mcp-deepseek', 'server.cjs')), true, 'the alias resolved the package paths')

  assert.equal(runner(['cancel', job.jobId], env).status, 0)
  fs.rmSync(root, { recursive: true, force: true })
})
