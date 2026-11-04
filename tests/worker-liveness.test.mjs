import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendControlLine,
  controlPathForSession,
  publishWorkerLiveness,
  unpublishWorkerLiveness,
  workerRegistryDir,
} from '../.agents/skills/deepseek-offload/scripts/lib/worker-liveness.mjs'

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'offload-liveness-'))
}

test('publishes and removes the registry record the GUI reads', () => {
  const dsh = home()
  const target = publishWorkerLiveness({
    jobId: 'job-1', sessionId: 'session-1', socketPath: '/tmp/job-1.sock', home: dsh, pid: process.pid,
  })
  assert.equal(path.dirname(target), workerRegistryDir(dsh))
  const record = JSON.parse(fs.readFileSync(target, 'utf8'))
  assert.equal(record.jobId, 'job-1')
  assert.equal(record.sessionId, 'session-1')
  assert.equal(record.socketPath, '/tmp/job-1.sock')
  assert.equal(record.pid, process.pid)
  assert.equal(typeof record.pidStart, 'string')
  unpublishWorkerLiveness(target)
  assert.equal(fs.existsSync(target), false)
})

test('finds the newest log generation and its control inbox', () => {
  const dsh = home()
  const dir = path.join(dsh, 'sessions', 'bucket', 'session-1')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), '')
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), '')
  assert.equal(
    controlPathForSession('session-1', dsh),
    path.join(dir, 'session.v4.control.jsonl'),
  )
  assert.equal(controlPathForSession('absent', dsh), null)
})

test('appends one line that carries the browser request id', () => {
  const dsh = home()
  const dir = path.join(dsh, 'sessions', 'bucket', 'session-1')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), '')
  const control = controlPathForSession('session-1', dsh)
  appendControlLine(control, { id: 'gui-1', text: 'hello', rpcId: 'req-1' })
  appendControlLine(control, { id: 'steer-2', text: 'plain' })
  const lines = fs.readFileSync(control, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines, [
    { id: 'gui-1', text: 'hello', rpcId: 'req-1' },
    { id: 'steer-2', text: 'plain' },
  ])
})

test('does not publish without a session or socket', () => {
  const dsh = home()
  assert.equal(publishWorkerLiveness({ jobId: 'job-1', sessionId: '', socketPath: '/s', home: dsh }), null)
  assert.equal(publishWorkerLiveness({ jobId: 'job-1', sessionId: 's', socketPath: '', home: dsh }), null)
})
