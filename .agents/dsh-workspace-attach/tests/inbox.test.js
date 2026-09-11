/**
 * Inbox protocol tests: file naming, atomic writes, request validation,
 * pruning, and directory resolution precedence.
 *
 * Run: node --test .agents/dsh-workspace-attach/tests/
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  PROTOCOL_VERSION,
  listRequests,
  pruneResults,
  readJson,
  requestFile,
  requireSessionId,
  resolveInboxDir,
  resultFile,
  validateRequest,
  writeHeartbeat,
  writeJsonAtomic,
} from '../src/inbox.js'

/** Create a throwaway inbox directory. */
async function scratch() {
  return await mkdtemp(join(tmpdir(), 'workspace-attach-test-'))
}

test('session ids are validated before they reach a file name', () => {
  assert.equal(requireSessionId('663058d3-3d32-401b-908f-3fa44e7678c2'), '663058d3-3d32-401b-908f-3fa44e7678c2')
  assert.throws(() => requireSessionId('../escape'), /invalid sessionId/)
  assert.throws(() => requireSessionId('nested/id'), /invalid sessionId/)
  assert.throws(() => requireSessionId(''), /invalid sessionId/)
  assert.throws(() => requireSessionId(undefined), /invalid sessionId/)
})

test('request and result files are named by session id', () => {
  assert.equal(requestFile('/inbox', 'abc'), '/inbox/abc.request.json')
  assert.equal(resultFile('/inbox', 'abc'), '/inbox/abc.result.json')
})

test('atomic writes round-trip and replace in place', async () => {
  const dir = await scratch()
  try {
    const file = join(dir, 'heartbeat.json')
    await writeJsonAtomic(file, { v: 1, pid: 1 })
    assert.deepEqual(await readJson(file), { v: 1, pid: 1 })
    await writeJsonAtomic(file, { v: 1, pid: 2 })
    assert.deepEqual(await readJson(file), { v: 1, pid: 2 })
    assert.deepEqual(await readdir(dir), ['heartbeat.json'], 'no temp files survive')
    assert.equal(await readJson(join(dir, 'missing.json')), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a malformed JSON file surfaces its parse error', async () => {
  const dir = await scratch()
  try {
    const file = join(dir, 'broken.json')
    await writeFile(file, '{ not json')
    await assert.rejects(() => readJson(file))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('listRequests returns only requests, in deterministic order', async () => {
  const dir = await scratch()
  try {
    await writeFile(join(dir, 'b.request.json'), '{}')
    await writeFile(join(dir, 'a.request.json'), '{}')
    await writeFile(join(dir, 'a.result.json'), '{}')
    await writeFile(join(dir, 'heartbeat.json'), '{}')
    assert.deepEqual(await listRequests(dir), [join(dir, 'a.request.json'), join(dir, 'b.request.json')])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('listRequests on a missing directory is empty, not an error', async () => {
  assert.deepEqual(await listRequests(join(tmpdir(), 'workspace-attach-absent-dir')), [])
})

test('pruneResults removes only expired result files', async () => {
  const dir = await scratch()
  try {
    const stale = resultFile(dir, 'stale')
    await writeJsonAtomic(stale, { ok: true })
    const fresh = resultFile(dir, 'fresh')
    await writeJsonAtomic(fresh, { ok: true })
    const heartbeat = join(dir, 'heartbeat.json')
    await writeHeartbeat(dir, { processed: 0 })
    assert.equal(await pruneResults(dir, -1), 2, 'a non-positive window expires every result')
    assert.deepEqual(await readdir(dir), ['heartbeat.json'], 'requests and heartbeat are untouched')
    assert.equal(await pruneResults(dir, 60_000), 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the heartbeat carries pid, plugin identity, and counters', async () => {
  const dir = await scratch()
  try {
    await writeHeartbeat(dir, { intervalMs: 1000, processed: 3, failed: 1 })
    const beat = await readJson(join(dir, 'heartbeat.json'))
    assert.equal(beat.v, PROTOCOL_VERSION)
    assert.equal(beat.plugin, 'dsh-workspace-attach')
    assert.equal(beat.pid, process.pid)
    assert.equal(beat.processed, 3)
    assert.equal(beat.failed, 1)
    assert.ok(!Number.isNaN(Date.parse(beat.at)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('validateRequest accepts a complete request and names what is missing', () => {
  assert.equal(validateRequest({ v: 1, sessionId: 'abc', path: '/home/u/project' }), undefined)
  assert.match(validateRequest(null), /not a JSON object/)
  assert.match(validateRequest({ v: 2, sessionId: 'abc', path: '/x' }), /unsupported request version 2/)
  assert.match(validateRequest({ v: 1, sessionId: '../x', path: '/x' }), /invalid sessionId/)
  assert.match(validateRequest({ v: 1, sessionId: 'abc' }), /no path/)
  assert.match(validateRequest({ v: 1, sessionId: 'abc', path: 'relative/dir' }), /not absolute/)
})

test('the inbox directory resolves config, then environment, then DSH home', () => {
  const savedHome = process.env.DSH_HOME
  const savedDir = process.env.DSH_WORKSPACE_ATTACH_DIR
  try {
    process.env.DSH_HOME = '/tmp/dsh-home'
    delete process.env.DSH_WORKSPACE_ATTACH_DIR
    assert.equal(resolveInboxDir(undefined), '/tmp/dsh-home/workspace-attach')
    process.env.DSH_WORKSPACE_ATTACH_DIR = '/tmp/from-env'
    assert.equal(resolveInboxDir(''), '/tmp/from-env')
    assert.equal(resolveInboxDir('/tmp/from-config'), '/tmp/from-config')
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    if (savedDir === undefined) delete process.env.DSH_WORKSPACE_ATTACH_DIR
    else process.env.DSH_WORKSPACE_ATTACH_DIR = savedDir
  }
})

test('the request file is rewritten atomically, never appended', async () => {
  const dir = await scratch()
  try {
    const file = requestFile(dir, 'abc')
    await writeJsonAtomic(file, { v: 1, sessionId: 'abc', path: '/home/u/project' })
    const raw = await readFile(file, 'utf8')
    assert.equal(raw.trimEnd().split('\n').length, 1, 'one JSON document, one line')
    assert.equal(JSON.parse(raw).sessionId, 'abc')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
