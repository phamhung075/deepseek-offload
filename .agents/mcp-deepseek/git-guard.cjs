/**
 * Git write guard for delegated DeepSeek jobs.
 *
 * A prompt that says "do not commit or push" is a request, not a barrier: a
 * delegated agent that ignores it can commit onto the user's branch and push to
 * the branch a production deploy watches. This module builds the barrier in the
 * job's own git environment, so it holds whatever the prompt says:
 *
 * - `core.hooksPath` points at generated hooks that refuse `git commit`,
 *   `git commit --amend`, `git merge` commits, and `git push`, each with a
 *   message telling the agent to report the change instead.
 * - `remote.origin.pushurl` points at a per-guard bare repository, so a push
 *   that bypasses the hooks (`--no-verify`) still cannot reach the real remote.
 * - The user's own global git configuration is included first, so identity,
 *   aliases, and every other setting keep working; the guard overrides only the
 *   two keys above.
 *
 * The guard reaches the job as `GIT_CONFIG_GLOBAL` in the environment of the
 * `dsh --profile acp` child the bridge spawns. Harness shell commands preserve
 * that variable: the subprocess environment scrub drops only credential-shaped
 * names and `DSH_*` names (`packages/subprocess/subprocess/src/index.ts`,
 * `scrubbedParentEnv`). Nothing here writes to the user's repository or to
 * their global git configuration; the whole guard lives in one directory under
 * `DEEPSEEK_OFFLOAD_GUARD_DIR` (default `$DSH_HOME/offload-guards`).
 *
 * @module dsh-mcp-deepseek/git-guard
 */

'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Hooks that refuse every git-history write a delegated job could attempt. */
const GUARD_HOOKS = ['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push']

/** One refusal per hook, phrased for the delegated agent that reads it. */
const REFUSALS = {
  'pre-commit': 'git commit refused: a delegated job must not create commits.',
  'pre-merge-commit': 'git merge commit refused: a delegated job must not create commits.',
  'commit-msg': 'git commit refused: a delegated job must not create commits.',
  'pre-push': 'git push refused: a delegated job must not push.',
}

/** Guards older than this are pruned when a new one is installed. */
const GUARD_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Whether this bridge was told to let jobs write git history.
 * @param env - process environment of the MCP bridge.
 * @returns true only for the exact opt-in value.
 */
function gitWritesAllowed(env = process.env) {
  return env.DEEPSEEK_MCP_ALLOW_GIT_WRITE === '1'
}

/**
 * The directory holding every guard, override-able for tests and for a project
 * that wants the guards beside its own scratch files.
 * @param env - process environment of the MCP bridge.
 * @returns an absolute directory path.
 */
function guardRoot(env = process.env) {
  if (typeof env.DEEPSEEK_OFFLOAD_GUARD_DIR === 'string' && env.DEEPSEEK_OFFLOAD_GUARD_DIR !== '') {
    return env.DEEPSEEK_OFFLOAD_GUARD_DIR
  }
  const dshHome = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'offload-guards')
}

/**
 * The global git configuration files the job would otherwise read. Git reads
 * only `GIT_CONFIG_GLOBAL` once it is set, so the guard includes these to keep
 * the user's identity and aliases in place.
 * @param options - `env` and `home` overrides.
 * @returns the existing files, in git's own precedence order.
 */
function userGlobalConfigPaths({ env = process.env, home = os.homedir() } = {}) {
  if (typeof env.GIT_CONFIG_GLOBAL === 'string' && env.GIT_CONFIG_GLOBAL !== '') {
    return [env.GIT_CONFIG_GLOBAL]
  }
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== ''
    ? path.join(env.XDG_CONFIG_HOME, 'git', 'config')
    : path.join(home, '.config', 'git', 'config')
  return [path.join(home, '.gitconfig'), xdg].filter((file) => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      // A missing global config is the common case for a fresh account.
      return false
    }
  })
}

/**
 * The shell source of one refusing hook.
 * @param name - hook name from {@link GUARD_HOOKS}.
 * @returns an executable POSIX shell script.
 */
function hookSource(name) {
  return '#!/bin/sh\n'
    + '# Installed by deepseek-offload: delegated jobs must not write git history.\n'
    + `printf '%s\\n' "${REFUSALS[name]} Report the change and let the caller review and merge it." >&2\n`
    + 'exit 1\n'
}

/**
 * The guard's git configuration: the user's own global config, the refusing
 * hooks, and the sandbox push target.
 * @param options - `hooks`, `sandbox`, and the included `userConfigs`.
 * @returns the configuration file body.
 */
function configSource({ hooks, sandbox, userConfigs }) {
  const include = userConfigs.length === 0
    ? ''
    : `[include]\n${userConfigs.map((file) => `\tpath = ${file}`).join('\n')}\n`
  return '# Installed by deepseek-offload for one delegated job; removed with its guard directory.\n'
    + include
    + `[core]\n\thooksPath = ${hooks}\n`
    + `[remote "origin"]\n\tpushurl = ${sandbox}\n`
}

/**
 * Build (or rebuild) the guard for one delegated job.
 *
 * Rebuilding is idempotent: the hooks and configuration are rewritten and the
 * bare sandbox repository is reused, so a bridge that reuses a guard id cannot
 * end up with a half-installed guard.
 * @param options - `root` guard directory, `id` of this guard, and optional
 * `env`/`home` used to locate the user's global git configuration.
 * @returns the guard, with `ok: false` and an `error` when git is unavailable.
 */
function installGitWriteGuard({ root, id, env = process.env, home = os.homedir() }) {
  const directory = path.join(root, id)
  const hooks = path.join(directory, 'hooks')
  const sandbox = path.join(directory, 'origin.git')
  const config = path.join(directory, 'gitconfig')
  const guard = { id, directory, config, hooks, sandbox }
  try {
    fs.mkdirSync(hooks, { recursive: true })
    for (const name of GUARD_HOOKS) {
      const file = path.join(hooks, name)
      fs.writeFileSync(file, hookSource(name))
      fs.chmodSync(file, 0o755)
    }
    const init = spawnSync('git', ['init', '--bare', '--quiet', sandbox], { encoding: 'utf8' })
    if (init.error) throw init.error
    if (init.status !== 0) {
      throw new Error(`git init --bare exited ${init.status}: ${(init.stderr || '').trim()}`)
    }
    fs.writeFileSync(config, configSource({ hooks, sandbox, userConfigs: userGlobalConfigPaths({ env, home }) }))
    pruneGuards(root, id)
    return { ...guard, ok: true }
  } catch (error) {
    return { ...guard, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The environment that puts one guard in force for a spawned job.
 * @param guard - a guard from {@link installGitWriteGuard}.
 * @returns entries to merge into the child's environment, empty when the guard
 * is not installed, since a broken guard must not stop the job.
 */
function guardEnvironment(guard) {
  return guard && guard.ok === true ? { GIT_CONFIG_GLOBAL: guard.config } : {}
}

/**
 * Delete guard directories older than {@link GUARD_TTL_MS}, never the one being
 * installed. Each MCP bridge process keeps one guard, so the root would grow
 * without this.
 * @param root - the guard root directory.
 * @param keepId - the guard id that must survive the sweep.
 */
function pruneGuards(root, keepId) {
  const cutoff = Date.now() - GUARD_TTL_MS
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    // The root is created by the caller of this sweep.
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepId) continue
    const target = path.join(root, entry.name)
    try {
      if (fs.statSync(target).mtimeMs >= cutoff) continue
      fs.rmSync(target, { recursive: true, force: true })
    } catch {
      // A guard that cannot be swept is untidy, never a reason to fail a job.
    }
  }
}

module.exports = {
  GUARD_HOOKS,
  gitWritesAllowed,
  guardEnvironment,
  guardRoot,
  installGitWriteGuard,
  userGlobalConfigPaths,
}
