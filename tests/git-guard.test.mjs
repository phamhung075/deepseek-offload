import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const guardModule = require('../.agents/mcp-deepseek/git-guard.cjs')

/** A fresh temporary directory for one fixture. */
function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-git-guard-${name}-`))
}

/** Run git, returning the raw result so a test can assert on the failure too. */
function git(cwd, args, env = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
}

/** Run git and require success. */
function mustGit(cwd, args, env = {}) {
  const out = git(cwd, args, env)
  assert.equal(out.status, 0, `git ${args.join(' ')} failed: ${out.stderr}`)
  return out.stdout.trim()
}

/**
 * A repository with a real bare origin, a seed commit already pushed, a user
 * global config carrying an identity, and one installed guard.
 */
function fixture(name) {
  const root = scratch(name)
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Real User\n\temail = real@example.com\n')

  const origin = path.join(root, 'origin.git')
  mustGit(root, ['init', '--bare', '--quiet', origin])
  const repo = path.join(root, 'repo')
  mustGit(root, ['init', '--quiet', '-b', 'main', repo])
  mustGit(repo, ['remote', 'add', 'origin', origin])
  fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n')
  mustGit(repo, ['add', 'file.txt'])
  mustGit(repo, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '--quiet', '-m', 'init'])
  mustGit(repo, ['push', '--quiet', '-u', 'origin', 'main'])

  const installed = guardModule.installGitWriteGuard({ root: path.join(root, 'guards'), id: 'job-1', env: {}, home })
  assert.equal(installed.ok, true, installed.error)
  return {
    root,
    home,
    origin,
    repo,
    guard: installed,
    env: {
      HOME: home,
      GIT_CONFIG_GLOBAL: installed.config,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }
}

test('the guard refuses every history write and redirects a push to its sandbox', () => {
  const { root, origin, repo, guard, env } = fixture('refuse')

  assert.deepEqual(
    fs.readdirSync(guard.hooks).sort(),
    ['commit-msg', 'pre-commit', 'pre-merge-commit', 'pre-push'],
  )
  for (const name of guardModule.GUARD_HOOKS) {
    assert.notEqual(fs.statSync(path.join(guard.hooks, name)).mode & 0o111, 0, `${name} must be executable`)
  }
  const config = fs.readFileSync(guard.config, 'utf8')
  assert.match(config, new RegExp(`hooksPath = ${guard.hooks.replace(/[/.]/g, '\\$&')}`))
  assert.match(config, new RegExp(`pushurl = ${guard.sandbox.replace(/[/.]/g, '\\$&')}`))
  assert.match(config, /path = .*\/home\/\.gitconfig/)
  assert.equal(mustGit(root, ['--git-dir', guard.sandbox, 'rev-parse', '--is-bare-repository'], env), 'true')

  const before = mustGit(repo, ['rev-list', '--count', 'main'], env)

  const commit = git(repo, ['commit', '--allow-empty', '-m', 'rogue'], env)
  assert.notEqual(commit.status, 0)
  assert.match(commit.stderr, /must not create commits/)

  const amend = git(repo, ['commit', '--amend', '--allow-empty', '-m', 'rogue'], env)
  assert.notEqual(amend.status, 0)

  const push = git(repo, ['push', 'origin', 'main'], env)
  assert.notEqual(push.status, 0)
  assert.match(push.stderr, /must not push/)

  // `--no-verify` defeats the hooks, which is exactly why the push URL is
  // redirected: the commit and the push both succeed, into the sandbox only.
  assert.equal(git(repo, ['commit', '--no-verify', '--allow-empty', '-m', 'rogue'], env).status, 0)
  assert.equal(git(repo, ['push', '--no-verify', 'origin', 'main'], env).status, 0)
  assert.equal(mustGit(repo, ['rev-list', '--count', 'main'], env), String(Number(before) + 1))
  assert.equal(mustGit(root, ['--git-dir', origin, 'rev-list', '--count', 'main'], env), before)
  assert.equal(mustGit(root, ['--git-dir', guard.sandbox, 'rev-list', '--count', 'main'], env), String(Number(before) + 1))
})

test('the guard keeps the identity and the read-side commands a job still needs', () => {
  const { repo, env } = fixture('identity')

  assert.equal(mustGit(repo, ['config', '--get', 'user.email'], env), 'real@example.com')

  fs.writeFileSync(path.join(repo, 'work.txt'), 'in progress\n')
  mustGit(repo, ['add', 'work.txt'], env)
  assert.match(mustGit(repo, ['status', '--short'], env), /A {2}work\.txt/)
  mustGit(repo, ['stash'], env)
  mustGit(repo, ['stash', 'pop'], env)
  mustGit(repo, ['checkout', '--quiet', '-b', 'feature'], env)
  mustGit(repo, ['tag', 'v1'], env)

  assert.notEqual(git(repo, ['commit', '-m', 'still refused'], env).status, 0)
})

test('a guard reports its environment only when it installed, and the opt-in lifts it', () => {
  assert.deepEqual(guardModule.guardEnvironment({ ok: false, error: 'no git' }), {})
  assert.deepEqual(guardModule.guardEnvironment(null), {})
  assert.deepEqual(guardModule.guardEnvironment({ ok: true, config: '/tmp/cfg' }), { GIT_CONFIG_GLOBAL: '/tmp/cfg' })

  assert.equal(guardModule.gitWritesAllowed({ DEEPSEEK_MCP_ALLOW_GIT_WRITE: '1' }), true)
  assert.equal(guardModule.gitWritesAllowed({ DEEPSEEK_MCP_ALLOW_GIT_WRITE: '0' }), false)
  assert.equal(guardModule.gitWritesAllowed({}), false)
})

test('reinstalling keeps the guard usable and sweeps the expired ones', () => {
  const { root, guard } = fixture('reinstall')

  const stale = path.join(path.dirname(guard.directory), 'bridge-9999')
  fs.mkdirSync(stale, { recursive: true })
  const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  fs.utimesSync(stale, longAgo, longAgo)

  const again = guardModule.installGitWriteGuard({ root: path.dirname(guard.directory), id: 'job-1', env: {}, home: path.join(root, 'home') })
  assert.equal(again.ok, true, again.error)
  assert.equal(fs.existsSync(stale), false, 'an expired guard is swept')
  assert.equal(fs.existsSync(again.directory), true, 'the reinstalled guard survives its own sweep')
})

test('the guard root defaults under DSH_HOME and honours its override', () => {
  assert.equal(guardModule.guardRoot({ DSH_HOME: '/tmp/dsh-home' }), path.join('/tmp/dsh-home', 'offload-guards'))
  assert.equal(guardModule.guardRoot({ DSH_HOME: '/tmp/dsh-home', DEEPSEEK_OFFLOAD_GUARD_DIR: '/tmp/elsewhere' }), '/tmp/elsewhere')
})
