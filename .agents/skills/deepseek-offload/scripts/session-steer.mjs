#!/usr/bin/env node
/**
 * Steer a running offload job, or read what it currently holds.
 *
 * Needs a Harness whose ACP child loads the fork `job-control` plugin (the
 * bridge adds its overlay automatically when `<DSH_ROOT>/fork/` exists). The
 * plugin watches `session.vN.control.jsonl` beside the session log and submits
 * each appended line to the running Agent as steering at its next step.
 *
 * Usage:
 *   node session-steer.mjs <jobId|sessionId> "text to inject"
 *   node session-steer.mjs <jobId|sessionId> --usage
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const target = args.find(argument => !argument.startsWith('--'))
const usage = args.includes('--usage')
const text = args.filter(argument => argument !== target && !argument.startsWith('--')).join(' ')
if (target === undefined || (!usage && text === '')) {
  console.error('usage: session-steer.mjs <jobId|sessionId> "text" | --usage')
  process.exit(2)
}
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

function resolveSessionId(value) {
  if (!value.startsWith('job-')) return value
  for (const root of [join(process.cwd(), 'scratch', 'dsh-offload', 'jobs'), process.cwd()]) {
    const candidate = join(root, `${value}.json`)
    if (!existsSync(candidate)) continue
    const record = JSON.parse(readFileSync(candidate, 'utf8'))
    if (typeof record.sessionId === 'string') return record.sessionId
  }
  throw new Error(`no job record for ${value} — run this from the directory the job was started in`)
}

/** Newest durable generation path for a session id across project buckets. */
function logPathOf(sessionId) {
  const root = join(dshHome, 'sessions')
  for (const bucket of readdirSync(root, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    const dir = join(root, bucket.name, sessionId)
    let names
    try {
      names = readdirSync(dir)
    } catch {
      // Only the bucket named after the job's working directory holds this session.
      continue
    }
    const newest = names
      .map(name => ({ name, match: LOG_NAME.exec(name) }))
      .filter(entry => entry.match !== null)
      .sort((a, b) => Number(b.match[1] ?? 0) - Number(a.match[1] ?? 0))[0]
    if (newest !== undefined) return join(dir, newest.name)
  }
  throw new Error(`no session log for ${sessionId} under ${root}`)
}

function sibling(logPath, extension) {
  for (const suffix of ['.jsonl.zstd', '.jsonl']) {
    if (logPath.endsWith(suffix)) return `${logPath.slice(0, -suffix.length)}${extension}`
  }
  throw new Error(`session log path does not carry a JSONL suffix: "${logPath}"`)
}

try {
  const logPath = logPathOf(resolveSessionId(target))
  if (usage) {
    const path = sibling(logPath, '.usage.json')
    if (!existsSync(path)) throw new Error(`no usage snapshot yet at ${path} (written after the first completed reply)`)
    process.stdout.write(readFileSync(path, 'utf8') + '\n')
  } else {
    const path = sibling(logPath, '.control.jsonl')
    appendFileSync(path, `${JSON.stringify({ id: `steer-${Date.now()}`, text })}\n`)
    console.log(`queued steering for the next step: ${path}`)
  }
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
