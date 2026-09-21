/**
 * Exercise session-tail.mjs against synthetic append-only session logs: several
 * complete frames up front, then a complete frame and a torn trailing frame
 * appended while a --watch run polls. Resolution cases cover the current
 * generation (`session.v3.jsonl.zstd`), the first generation (`session.jsonl.zstd`),
 * an uncompressed log, a frozen predecessor beside the current generation, and a
 * directory holding only the live frame channel — which is not a log.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as zlib from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const tailer = join(here, '..', '.agents', 'skills', 'deepseek-offload', 'scripts', 'session-tail.mjs')
const home = mkdtempSync(join(tmpdir(), 'dsh-session-tail-'))

after(() => { rmSync(home, { recursive: true, force: true }) })

/** Create one session directory and return its durable log path. */
function makeSession(sessionId, logName) {
  const dir = join(home, 'sessions', '--tmp-project--', sessionId)
  mkdirSync(dir, { recursive: true })
  return { sessionId, dir, log: join(dir, logName) }
}

const record = (time, command) => ({
  type: 'tool/call',
  time,
  data: { name: 'bash', arguments: JSON.stringify({ command }) },
})
const frame = records => {
  const bytes = Buffer.from(records.map(entry => `${JSON.stringify(entry)}\n`).join(''), 'utf8')
  if (typeof zlib.zstdCompressSync === 'function') {
    return zlib.zstdCompressSync(bytes)
  }
  return execFileSync('zstd', ['-q'], { input: bytes })
}
const rows = records => records.map(entry => `${JSON.stringify(entry)}\n`).join('')
/** One live-channel line: a text-delta frame as the persistence provider publishes it. */
const liveText = (seq, time, text, attemptId = 'attempt-1') => `${JSON.stringify({
  seq,
  frame: {
    type: 'chunk',
    attemptId,
    revision: 1,
    index: 1,
    time,
    chunk: { type: 'text-delta', index: 1, text },
  },
})}\n`
const run = (sessionId, args) => execFileSync(process.execPath, [tailer, sessionId, ...args], {
  env: { ...process.env, DSH_HOME: home },
  encoding: 'utf8',
  // A failing resolution prints its own stack; the assertion reads the message.
  stdio: ['ignore', 'pipe', 'pipe'],
})
/** Run the tailer in the background and read everything it prints. */
function tail(sessionId, args) {
  const child = spawn(process.execPath, [tailer, sessionId, ...args], {
    env: { ...process.env, DSH_HOME: home },
  })
  const state = { text: '', child }
  child.stdout.on('data', chunk => { state.text += chunk })
  return state
}

/** Poll until `read` satisfies `predicate`, or fail with the text seen so far. */
async function waitFor(read, predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(read())) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`timed out waiting for ${label}; saw:\n${read()}`)
}

test('reads every frame of an append-only current-generation session log', () => {
  const { sessionId, log } = makeSession('current-generation', 'session.v3.jsonl.zstd')
  writeFileSync(log, Buffer.concat([
    frame([record(1789283000000, 'echo first-frame'), record(1789283001000, 'echo still-first')]),
    frame([record(1789283002000, 'echo second-frame')]),
  ]))
  const output = run(sessionId, ['--lines', '10'])
  assert.match(output, /echo first-frame/)
  assert.match(output, /echo still-first/)
  assert.match(output, /echo second-frame/)
})

test('reads an uncompressed first-generation session log', () => {
  const { sessionId, log } = makeSession('uncompressed-first', 'session.jsonl')
  writeFileSync(log, rows([
    { type: 'turn/start', time: 1789283000000, data: {} },
    record(1789283001000, 'echo plain-row'),
  ]))
  const output = run(sessionId, ['--lines', '10'])
  assert.match(output, /turn start/)
  assert.match(output, /echo plain-row/)
})

test('prints the current generation, not the frozen predecessor beside it', () => {
  const { sessionId, dir, log } = makeSession('migrated', 'session.v3.jsonl.zstd')
  writeFileSync(join(dir, 'session.jsonl.zstd'), frame([record(1789283000000, 'echo frozen-predecessor')]))
  writeFileSync(log, frame([record(1789283001000, 'echo live-successor')]))
  const output = run(sessionId, ['--lines', '10'])
  assert.match(output, /echo live-successor/)
  assert.doesNotMatch(output, /echo frozen-predecessor/)
})

test('a directory holding only the live frame channel reports no session log', () => {
  const { sessionId, dir } = makeSession('channel-only', 'session.v3.jsonl.zstd')
  rmSync(join(dir, 'session.v3.jsonl.zstd'), { force: true })
  writeFileSync(join(dir, 'session.v3.stream.jsonl'), liveText(1, 1789283000000, 'channel text is not a log'))
  assert.throws(
    () => run(sessionId, ['--lines', '10']),
    error => /no session log for channel-only/.test(String(error.stderr))
      && /session\.vN\.jsonl\.zstd/.test(String(error.stderr)),
  )
})

test('--watch streams new frames and waits out a torn trailing frame', async () => {
  const { sessionId, log } = makeSession('torn-durable-frame', 'session.v3.jsonl.zstd')
  writeFileSync(log, frame([record(1789283000000, 'echo first-frame'), record(1789283001000, 'echo second-frame')]))
  const state = tail(sessionId, ['--watch', '--interval-ms', '200'])
  const read = () => state.text
  try {
    await waitFor(read, text => text.includes('echo second-frame'), 'the opening snapshot')

    appendFileSync(log, frame([record(1789283003000, 'echo appended-while-watching')]))
    await waitFor(read, text => text.includes('echo appended-while-watching'), 'an appended frame')

    const torn = frame([record(1789283004000, 'echo torn-frame')])
    appendFileSync(log, torn.subarray(0, Math.floor(torn.length / 2)))
    await new Promise(resolve => setTimeout(resolve, 600))
    assert.doesNotMatch(read(), /echo torn-frame/, 'a half-written frame must not be reported')

    appendFileSync(log, torn.subarray(Math.floor(torn.length / 2)))
    await waitFor(read, text => text.includes('echo torn-frame'), 'the completed torn frame')
    assert.doesNotMatch(read(), /session-tail:/, 'the tailer must not fail on a torn tail')
  } finally {
    state.child.kill('SIGTERM')
  }
})

test('--watch prints Assistant text from the live channel as it is published', async () => {
  const { sessionId, dir, log } = makeSession('live-text', 'session.v3.jsonl.zstd')
  writeFileSync(log, frame([record(1789283000000, 'echo opening-activity')]))
  const channel = join(dir, 'session.v3.stream.jsonl')
  writeFileSync(channel, liveText(1, 1789283000000, 'text published before the watch'))
  const state = tail(sessionId, ['--watch', '--interval-ms', '200'])
  const read = () => state.text
  try {
    await waitFor(read, text => text.includes('echo opening-activity'), 'the opening snapshot')
    assert.doesNotMatch(read(), /text published before the watch/, 'only new frames are printed')

    appendFileSync(channel, liveText(2, 1789283001000, 'Reading'))
    appendFileSync(channel, liveText(2, 1789283002000, ' the file'))
    await waitFor(read, text => text.includes('assistant: Reading the file'), 'streamed Assistant text')

    const torn = liveText(2, 1789283003000, ' torn-live-text')
    appendFileSync(channel, torn.slice(0, Math.floor(torn.length / 2)))
    await new Promise(resolve => setTimeout(resolve, 600))
    assert.doesNotMatch(read(), /torn-live-text/, 'a half-written channel line must not be reported')

    appendFileSync(channel, torn.slice(Math.floor(torn.length / 2)))
    await waitFor(read, text => text.includes('torn-live-text'), 'the completed channel line')
    assert.doesNotMatch(read(), /session-tail:/, 'the tailer must not fail on a torn channel line')
  } finally {
    state.child.kill('SIGTERM')
  }
})

test('--no-text leaves the live channel unread', async () => {
  const { sessionId, dir, log } = makeSession('no-text', 'session.v3.jsonl.zstd')
  writeFileSync(log, frame([record(1789283000000, 'echo opening-activity')]))
  const channel = join(dir, 'session.v3.stream.jsonl')
  const state = tail(sessionId, ['--watch', '--no-text', '--interval-ms', '200'])
  const read = () => state.text
  try {
    await waitFor(read, text => text.includes('echo opening-activity'), 'the opening snapshot')
    appendFileSync(channel, liveText(1, 1789283001000, 'suppressed-live-text'))
    await new Promise(resolve => setTimeout(resolve, 800))
    assert.doesNotMatch(read(), /suppressed-live-text/)
  } finally {
    state.child.kill('SIGTERM')
  }
})
