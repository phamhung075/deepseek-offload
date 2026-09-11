/**
 * Adoption of one externally created session into a Workspace.
 *
 * A session may only join a Workspace whose path equals the session's stored
 * header `cwd` (`WorkspaceEntity.attachSession` revalidates exactly that), so
 * the request's `path` is the directory the delegated agent actually ran in.
 * The Workspace is created on demand and its title comes from the registry's
 * own default, the directory's base name — the project folder the caller
 * invoked the bridge from.
 *
 * Creating before attaching means a rejection can leave a Workspace with no
 * sessions behind; a Workspace this call created is therefore removed again
 * when the attach fails, so a mistyped or nested path cannot litter the
 * sidebar.
 *
 * @module dsh-workspace-attach/adopt
 */

/**
 * @typedef {object} AdoptResult
 * @property {boolean} ok - whether the session is accounted after this call.
 * @property {string} sessionId - the session the request named.
 * @property {string} [workspaceId] - accounting Workspace, when attached.
 * @property {string} [path] - canonical Workspace path.
 * @property {string} [title] - Workspace display title.
 * @property {boolean} [created] - whether this call created the Workspace.
 * @property {boolean} [already] - whether the session was already accounted.
 * @property {boolean} [rolledBack] - whether a created Workspace was removed again.
 * @property {string} [error] - failure reason when `ok` is false.
 */

/**
 * Account one session under the Workspace for the directory it ran in.
 * @param registry - `ctx.workspaceRegistry`.
 * @param request - validated request fields (`sessionId`, `path`).
 * @returns the adoption outcome, never throwing for a rejected request.
 */
export async function adoptSession(registry, request) {
  const { sessionId, path } = request
  let existing
  try {
    existing = await registry.resolveByPath(path)
  } catch (error) {
    return {
      ok: false,
      sessionId,
      error: `cannot resolve a workspace at "${path}": ${message(error)}`,
    }
  }
  if (existing !== undefined && existing.sessionIds.includes(sessionId)) {
    return {
      ok: true,
      sessionId,
      workspaceId: existing.id,
      path: existing.path,
      title: existing.title,
      already: true,
    }
  }

  let workspace = existing
  let created = false
  if (workspace === undefined) {
    try {
      workspace = await registry.create(path)
      created = true
    } catch (error) {
      return {
        ok: false,
        sessionId,
        error: `cannot create a workspace at "${path}": ${message(error)}`,
      }
    }
  }

  try {
    await workspace.attachSession(sessionId)
  } catch (error) {
    const rolledBack = created ? await rollback(registry, workspace.id) : false
    return {
      ok: false,
      sessionId,
      workspaceId: workspace.id,
      path: workspace.path,
      title: workspace.title,
      created,
      rolledBack,
      error: message(error),
    }
  }

  return {
    ok: true,
    sessionId,
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    created,
  }
}

/**
 * Remove a Workspace this call created after its attach was rejected.
 * @param registry - `ctx.workspaceRegistry`.
 * @param workspaceId - the Workspace to remove.
 * @returns whether the registration was removed.
 */
async function rollback(registry, workspaceId) {
  try {
    return await registry.delete(workspaceId)
  } catch {
    // An unremoved empty Workspace is untidy but harmless; the attach failure
    // is the fact the caller must see, so it stays the reported error.
    return false
  }
}

/**
 * @param error - thrown value.
 * @returns its message.
 */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
