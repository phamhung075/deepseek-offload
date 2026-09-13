/**
 * Exercise session-tail.mjs against synthetic append-only session logs: several
 * complete frames up front, then a complete frame and a torn trailing frame
 * appended while a --watch run polls.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const tailer = join(here, '..', '.agents', 'skills', 'deepseek-offload', 'scripts', 'session-tail.mjs')
const home = mkdtempSync(join(tmpdir(), 'dsh-session-tail-'))
const sessionId = 'session-under-test'
const sessionDir = join(home, 'sessions', '--tmp-project--', sessionId)
mkdirSync(sessionDir, { recursive: true })
const log = join(sessionDir, 'session.jsonl.zstd')

after(() => { rmSync(home, { recursive: true, force: true }) })

const record = (time, command) => ({
  type: 'tool/call',
  time,
  data: { name: 'bash', arguments: JSON.stringify({ command }) },
})
const frame = records => zstdCompressSync(Buffer.from(records.map(entry => `${JSON.stringify(entry)}\n`).join(''), 'utf8'))
const run = args => execFileSync(process.execPath, [tailer, sessionId, ...args], {
  env: { ...process.env, DSH_HOME: home },
  encoding: 'utf8',
})

/** Poll until `read` satisfies `predicate`, or fail with the text seen so far. */
async function waitFor(read, predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(read())) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`timed out waiting for ${label}; saw:\n${read()}`)
}

test('reads every frame of an append-only session log', () => {
  writeFileSync(log, Buffer.concat([
    frame([record(1789283000000, 'echo first-frame'), record(1789283001000, 'echo still-first')]),
    frame([record(1789283002000, 'echo second-frame')]),
  ]))
  const output = run(['--lines', '10'])
  assert.match(output, /echo first-frame/)
  assert.match(output, /echo still-first/)
  assert.match(output, /echo second-frame/)
})

test('--watch streams new frames and waits out a torn trailing frame', async () => {
  const child = spawn(process.execPath, [tailer, sessionId, '--watch', '--interval-ms', '200'], {
    env: { ...process.env, DSH_HOME: home },
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  const read = () => output
  try {
    await waitFor(read, text => text.includes('echo second-frame'), 'the opening snapshot')

    appendFileSync(log, frame([record(1789283003000, 'echo appended-while-watching')]))
    await waitFor(read, text => text.includes('echo appended-while-watching'), 'an appended frame')

    const torn = frame([record(1789283004000, 'echo torn-frame')])
    appendFileSync(log, torn.subarray(0, Math.floor(torn.length / 2)))
    await new Promise(resolve => setTimeout(resolve, 600))
    assert.doesNotMatch(output, /echo torn-frame/, 'a half-written frame must not be reported')

    appendFileSync(log, torn.subarray(Math.floor(torn.length / 2)))
    await waitFor(read, text => text.includes('echo torn-frame'), 'the completed torn frame')
    assert.doesNotMatch(output, /session-tail:/, 'the tailer must not fail on a torn tail')
  } finally {
    child.kill('SIGTERM')
  }
})
