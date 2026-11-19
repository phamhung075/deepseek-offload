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
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
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

// ---------------------------------------------------------------------------
// resume and update read their text through the same code path as start
// ---------------------------------------------------------------------------

/** A finished job record with a session, so `resume` accepts it. */
function finishedJob(root, overrides = {}) {
  const job = {
    jobId: 'job-20260101-000000-beef',
    label: 'prompt-file',
    state: 'error',
    prompt: 'original task',
    cwd: root,
    mcpConfig: null,
    permission: 'allow',
    allowGitWrite: false,
    readOnly: true,
    timeoutMs: 60_000,
    sessionId: 'old-session',
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now() - 1_000,
    ...overrides,
  }
  fs.mkdirSync(path.join(root, 'jobs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'jobs', `${job.jobId}.json`), JSON.stringify(job))
  return job
}

const BACKTICK_TEXT = 'Run `verify-aa2 <feature>` first\n\n```sh\necho `whoami` $(date)\n```'

test('readPromptText: words, file, `-` and the both-given refusal', async () => {
  const { readPromptText } = await import('../.agents/skills/deepseek-offload/scripts/lib/prompt-file.mjs')
  const fail = (message) => { throw new Error(message) }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-prompt-unit-'))
  const file = promptFile(root, `${BACKTICK_TEXT}\n`)
  const noStdin = () => { throw new Error('stdin must not be read') }

  assert.equal(readPromptText({}, ['a', 'b'], { fail, readStdin: noStdin }), 'a b')
  assert.equal(readPromptText({ 'prompt-file': file }, [], { fail, readStdin: noStdin }), BACKTICK_TEXT)
  assert.equal(readPromptText({ f: file }, [], { fail, readStdin: noStdin }), BACKTICK_TEXT)
  assert.equal(readPromptText({}, ['-'], { fail, readStdin: () => 'piped\n' }), 'piped')
  assert.throws(() => readPromptText({ f: file }, ['extra'], { fail }), /not both/)
  assert.throws(() => readPromptText({ f: path.join(root, 'nope') }, [], { fail }), /prompt file not found/)
  // An optional text (resume) never blocks on a non-TTY stdin; start opts in.
  assert.equal(readPromptText({}, [], { fail, stdinIsTTY: false, readStdin: noStdin }), '')
  assert.equal(readPromptText({}, [], { fail, implicitStdin: true, stdinIsTTY: false, readStdin: () => 'p' }), 'p')

  fs.rmSync(root, { recursive: true, force: true })
})

for (const form of [['--prompt-file'], ['-f'], ['-']]) {
  test(`resume ${form[0]} carries extra text with backticks verbatim`, () => {
    const { root, env } = scratch(`resume${form[0]}`)
    const original = finishedJob(root)
    const file = promptFile(root, `${BACKTICK_TEXT}\n`)
    const args = form[0] === '-' ? ['-'] : [form[0], file]

    const out = runner(['resume', original.jobId, ...args, '--json'], env, form[0] === '-' ? { input: `${BACKTICK_TEXT}\n` } : {})
    assert.equal(out.status, 0, out.stderr)
    const job = JSON.parse(out.stdout)
    assert.equal(job.resumeOf, original.jobId)
    assert.ok(job.prompt.endsWith(`Additional instructions for this continuation:\n${BACKTICK_TEXT}`), job.prompt)

    runner(['cancel', job.jobId], env)
    fs.rmSync(root, { recursive: true, force: true })
  })
}

test('resume refuses both an extra argument and --prompt-file', () => {
  const { root, env } = scratch('resume-both')
  const original = finishedJob(root)
  const file = promptFile(root, 'from the file')

  const out = runner(['resume', original.jobId, 'inline words', '-f', file], env)
  assert.equal(out.status, 1)
  assert.match(out.stderr, /either as an argument or with --prompt-file, not both/)
  fs.rmSync(root, { recursive: true, force: true })
})

/** Run the runner without blocking this process, so a test socket can answer. */
function runnerAsync(args, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    child.stdin.end(input ?? '')
  })
}

for (const form of ['--prompt-file', '-f', '-']) {
  test(`update ${form} sends a message with backticks verbatim to the worker socket`, async () => {
    const { root, env } = scratch(`update${form}`)
    const socketPath = path.join(root, 'w.sock')
    const received = []
    const server = net.createServer((conn) => {
      let buffer = ''
      conn.on('data', (chunk) => {
        buffer += chunk
        if (!buffer.includes('\n')) return
        received.push(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))))
        conn.end(`${JSON.stringify({ ok: true })}\n`)
      })
    })
    await new Promise((resolve) => server.listen(socketPath, resolve))
    // The test process stands in for the live worker.
    const job = finishedJob(root, { state: 'running', pid: process.pid, socketPath, finishedAt: undefined })
    const file = promptFile(root, `${BACKTICK_TEXT}\n`)
    const args = form === '-' ? ['-'] : [form, file]

    const out = await runnerAsync(['update', job.jobId, ...args, '--json'], env, form === '-' ? `${BACKTICK_TEXT}\n` : '')
    server.close()
    assert.equal(out.status, 0, out.stderr)
    assert.deepEqual(received, [{ message: BACKTICK_TEXT }])
    assert.equal(JSON.parse(out.stdout).message, BACKTICK_TEXT)
    fs.rmSync(root, { recursive: true, force: true })
  })
}

test('update with a missing prompt file fails before touching the job', () => {
  const { root, env } = scratch('update-missing')
  const job = finishedJob(root, { state: 'running', pid: process.pid })
  const missing = path.join(root, 'nope.md')

  const out = runner(['update', job.jobId, '--prompt-file', missing], env)
  assert.equal(out.status, 1)
  assert.match(out.stderr, /prompt file not found/)
  fs.rmSync(root, { recursive: true, force: true })
})
