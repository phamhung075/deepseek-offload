/**
 * Adoption semantics against a stub registry: create-on-demand, idempotent
 * re-runs, rejected attaches, and the rollback that keeps a bad request from
 * leaving an empty Workspace in the sidebar.
 *
 * Run: node --test .agents/dsh-workspace-attach/tests/
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adoptSession } from '../src/adopt.js'

/** Minimal in-memory stand-in for ctx.workspaceRegistry. */
function stubRegistry({ existing, createError, attachError } = {}) {
  const calls = { resolve: [], create: [], attach: [], delete: [] }
  const workspaces = new Map()
  if (existing !== undefined) workspaces.set(existing.path, existing)
  return {
    calls,
    workspaces,
    async resolveByPath(path) {
      calls.resolve.push(path)
      return workspaces.get(path)
    },
    async create(path) {
      calls.create.push(path)
      if (createError !== undefined) throw createError
      const workspace = {
        id: `ws-${workspaces.size + 1}`,
        path,
        title: path.split('/').filter(Boolean).pop(),
        sessionIds: [],
      }
      workspaces.set(path, workspace)
      return workspace
    },
    async delete(id) {
      calls.delete.push(id)
      for (const [path, workspace] of workspaces) {
        if (workspace.id === id) workspaces.delete(path)
      }
      return true
    },
    attachFor(workspaceId) {
      return async () => {
        calls.attach.push(workspaceId)
        if (attachError !== undefined) throw attachError
      }
    },
  }
}

/** A registry whose entities record attaches on the shared call log. */
function registryWithEntities(options) {
  const registry = stubRegistry(options)
  const create = registry.create
  registry.create = async (path) => {
    const workspace = await create(path)
    workspace.attachSession = registry.attachFor(workspace.id)
    return workspace
  }
  if (options?.existing !== undefined) {
    options.existing.attachSession = registry.attachFor(options.existing.id)
  }
  return registry
}

test('creates the workspace for the session directory and attaches', async () => {
  const registry = registryWithEntities()
  const result = await adoptSession(registry, { sessionId: 'abc-1', path: '/home/u/project' })

  assert.equal(result.ok, true)
  assert.equal(result.created, true)
  assert.equal(result.title, 'project')
  assert.deepEqual(registry.calls.create, ['/home/u/project'])
  assert.deepEqual(registry.calls.attach, ['ws-1'])
})

test('joins an existing workspace without creating another', async () => {
  const existing = { id: 'ws-9', path: '/home/u/project', title: 'project', sessionIds: [] }
  const registry = registryWithEntities({ existing })
  const result = await adoptSession(registry, { sessionId: 'abc-2', path: '/home/u/project' })

  assert.equal(result.ok, true)
  assert.equal(result.created, false)
  assert.equal(result.workspaceId, 'ws-9')
  assert.deepEqual(registry.calls.create, [])
  assert.deepEqual(registry.calls.attach, ['ws-9'])
})

test('a second request for an accounted session is a no-op', async () => {
  const existing = { id: 'ws-9', path: '/home/u/project', title: 'project', sessionIds: ['abc-3'] }
  const registry = registryWithEntities({ existing })
  const result = await adoptSession(registry, { sessionId: 'abc-3', path: '/home/u/project' })

  assert.equal(result.ok, true)
  assert.equal(result.already, true)
  assert.deepEqual(registry.calls.attach, [], 'an accounted session is not re-attached')
})

test('a rejected attach removes the workspace this call created', async () => {
  const attachError = new Error(
    "cannot attach session 'abc-4' to workspace '/home/u/project': its cwd resolves to '/home/u/project/scratch'",
  )
  const registry = registryWithEntities({ attachError })
  const result = await adoptSession(registry, { sessionId: 'abc-4', path: '/home/u/project' })

  assert.equal(result.ok, false)
  assert.equal(result.rolledBack, true)
  assert.match(result.error, /its cwd resolves to/)
  assert.deepEqual(registry.calls.delete, ['ws-1'])
  assert.equal(registry.workspaces.size, 0)
})

test('a rejected attach keeps a workspace that already existed', async () => {
  const existing = { id: 'ws-9', path: '/home/u/project', title: 'project', sessionIds: ['other'] }
  const registry = registryWithEntities({ existing, attachError: new Error('cwd mismatch') })
  const result = await adoptSession(registry, { sessionId: 'abc-5', path: '/home/u/project' })

  assert.equal(result.ok, false)
  assert.equal(result.rolledBack, false)
  assert.deepEqual(registry.calls.delete, [], 'a pre-existing workspace is never removed')
  assert.equal(registry.workspaces.size, 1)
})

test('an unresolvable directory is reported without creating anything', async () => {
  const registry = registryWithEntities()
  registry.resolveByPath = async () => {
    const error = new Error("ENOENT: no such file or directory, realpath '/nope'")
    error.code = 'ENOENT'
    throw error
  }
  const result = await adoptSession(registry, { sessionId: 'abc-6', path: '/nope' })

  assert.equal(result.ok, false)
  assert.match(result.error, /cannot resolve a workspace at "\/nope"/)
  assert.match(result.error, /ENOENT/)
  assert.deepEqual(registry.calls.create, [])
})

test('a refused create reports the registry message', async () => {
  const registry = registryWithEntities({ createError: new Error('path is not a directory') })
  const result = await adoptSession(registry, { sessionId: 'abc-7', path: '/home/u/file.txt' })

  assert.equal(result.ok, false)
  assert.match(result.error, /cannot create a workspace at "\/home\/u\/file.txt": path is not a directory/)
})
