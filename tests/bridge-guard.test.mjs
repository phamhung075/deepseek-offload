import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE = fileURLToPath(new URL('../.agents/mcp-deepseek/server.cjs', import.meta.url))

/** A fresh temporary directory for one fixture. */
function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-bridge-guard-${name}-`))
}

/** Run git, returning the raw result. */
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
 * A repository with a real bare origin, a user global config carrying an
 * identity, and a stub ACP child that runs the git probe a job would run.
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

  const report = path.join(root, 'probe.json')
  const stub = path.join(root, 'stub-dsh.cjs')
  fs.writeFileSync(stub, stubSource())
  fs.chmodSync(stub, 0o755)
  return { root, home, origin, repo, report, stub }
}

/**
 * A stand-in for `dsh --profile acp`: it answers just enough ACP for one
 * `deepseek_agent` call, and instead of reasoning it runs the two git commands
 * a rogue job would run, writing their results to `STUB_REPORT`.
 */
function stubSource() {
  return `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const cwd = process.env.STUB_CWD
const run = (args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { args, status: out.status, stdout: out.stdout.trim(), stderr: out.stderr.trim() }
}
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.method === 'session/prompt') {
      fs.writeFileSync(process.env.STUB_REPORT, JSON.stringify({
        gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL || null,
        toplevel: run(['rev-parse', '--show-toplevel']),
        commit: run(['commit', '--allow-empty', '-m', 'guard probe']),
        push: run(['push', 'origin', 'main']),
      }, null, 2))
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'stub-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'probe complete' } } },
      })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      continue
    }
    if (msg.id === undefined || msg.id === null) continue
    send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'session/new' ? { sessionId: 'stub-session' } : {} })
  }
})
`
}

/**
 * Start the real bridge against the stub child and run one `deepseek_agent`
 * call, returning the tool result text.
 * @param fixture - the fixture from {@link fixture}.
 * @returns the MCP tool result text.
 */
function callAgent(fixture) {
  return new Promise((resolve, reject) => {
    const bridge = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        HOME: fixture.home,
        GIT_CONFIG_NOSYSTEM: '1',
        DSH_HOME: path.join(fixture.root, 'dsh-home'),
        DSH_BIN: fixture.stub,
        DEEPSEEK_OFFLOAD_GUARD_DIR: path.join(fixture.root, 'guards'),
        DEEPSEEK_MCP_DEFAULT_CWD: fixture.repo,
        DEEPSEEK_WORKSPACE_ATTACH: '0',
        STUB_CWD: fixture.repo,
        STUB_REPORT: fixture.report,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = ''
    let stderr = ''
    const timer = setTimeout(() => {
      bridge.kill('SIGKILL')
      reject(new Error(`bridge did not answer in time; stderr:\n${stderr}`))
    }, 30_000)
    bridge.stderr.setEncoding('utf8')
    bridge.stderr.on('data', (chunk) => { stderr += chunk })
    bridge.stdout.setEncoding('utf8')
    bridge.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        if (msg.id === 2 && msg.result) {
          clearTimeout(timer)
          bridge.kill('SIGTERM')
          resolve(msg.result.content[0].text)
        }
      }
    })
    bridge.on('error', reject)
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`)
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'deepseek_agent', arguments: { prompt: 'run the guard probe' } } })}\n`)
  })
}

test('the bridge spawns a job under a guard that refuses commits and pushes', async () => {
  const fx = fixture('spawn')
  const before = mustGit(fx.repo, ['rev-list', '--count', 'main'])
  const text = await callAgent(fx)

  const probe = JSON.parse(fs.readFileSync(fx.report, 'utf8'))
  const guardDir = path.join(fx.root, 'guards')
  assert.equal(path.dirname(path.dirname(probe.gitConfigGlobal)), guardDir, 'the job inherited the guard config')
  assert.equal(probe.toplevel.stdout, fx.repo)
  assert.notEqual(probe.commit.status, 0)
  assert.match(probe.commit.stderr, /must not create commits/)
  assert.notEqual(probe.push.status, 0)
  assert.match(probe.push.stderr, /must not push/)

  // The remote the repo actually points at never moved.
  assert.equal(mustGit(fx.repo, ['rev-list', '--count', 'main']), before)
  assert.equal(mustGit(fx.root, ['--git-dir', fx.origin, 'rev-list', '--count', 'main']), before)

  assert.match(text, /^GitWrites: guarded — commits refused, pushes to a remote named origin redirected to .*origin\.git;/m)
  assert.match(text, /probe complete/)
})

test('DEEPSEEK_MCP_ALLOW_GIT_WRITE=1 lifts the guard for a job that must write', async () => {
  const fx = fixture('optout')
  const text = await new Promise((resolve, reject) => {
    const bridge = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        HOME: fx.home,
        GIT_CONFIG_NOSYSTEM: '1',
        DSH_HOME: path.join(fx.root, 'dsh-home'),
        DSH_BIN: fx.stub,
        DEEPSEEK_OFFLOAD_GUARD_DIR: path.join(fx.root, 'guards'),
        DEEPSEEK_MCP_DEFAULT_CWD: fx.repo,
        DEEPSEEK_WORKSPACE_ATTACH: '0',
        DEEPSEEK_MCP_ALLOW_GIT_WRITE: '1',
        STUB_CWD: fx.repo,
        STUB_REPORT: fx.report,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = ''
    const timer = setTimeout(() => { bridge.kill('SIGKILL'); reject(new Error('bridge did not answer in time')) }, 30_000)
    bridge.stdout.setEncoding('utf8')
    bridge.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        if (msg.id === 2 && msg.result) {
          clearTimeout(timer)
          bridge.kill('SIGTERM')
          resolve(msg.result.content[0].text)
        }
      }
    })
    bridge.on('error', reject)
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`)
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'deepseek_agent', arguments: { prompt: 'run the guard probe' } } })}\n`)
  })

  const probe = JSON.parse(fs.readFileSync(fx.report, 'utf8'))
  assert.equal(probe.gitConfigGlobal, null, 'no guard config is exported when the caller opts out')
  assert.equal(probe.commit.status, 0)
  assert.match(text, /^GitWrites: ALLOWED — DEEPSEEK_MCP_ALLOW_GIT_WRITE=1/m)
})
