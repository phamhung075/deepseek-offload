#!/usr/bin/env node
/**
 * Print the live tail of a DeepSeek Harness session log.
 *
 * The web GUI cannot show a session another process is running — an offload
 * job runs in the separate `dsh --profile acp` child the bridge spawns — so
 * this reads the durable log directly instead. The log is an append-only
 * Zstandard stream with one frame per append and JSONL inside each frame, so
 * every frame must be walked: one `zstdDecompressSync` call returns only the
 * first frame.
 *
 * Usage:
 *   node session-tail.mjs <jobId|sessionId> [--lines N] [--watch] [--json]
 *                          [--interval-ms N]
 *
 * `--watch` polls and prints each new activity line, then exits when the job
 * record stops reading `running`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const target = args.find(argument => !argument.startsWith('--'))
if (target === undefined || target === '') {
  console.error('usage: session-tail.mjs <jobId|sessionId> [--lines N] [--watch] [--json] [--interval-ms N]')
  process.exit(2)
}
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : Number(args[index + 1])
}
const lineCount = option('--lines', 12)
const watch = args.includes('--watch')
const asJson = args.includes('--json')
const intervalMs = option('--interval-ms', 3000)
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** How often an idle --watch run reprints its position. */
const IDLE_HEARTBEAT_MS = 30_000

/** Job records live under the dispatching project's scratch tree. */
function jobRecordPath(jobId) {
  const roots = [join(process.cwd(), 'scratch', 'dsh-offload', 'jobs'), process.cwd()]
  for (const root of roots) {
    if (!existsSync(root)) continue
    const candidate = join(root, `${jobId}.json`)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function readJobState(recordPath) {
  if (recordPath === undefined || !existsSync(recordPath)) return undefined
  try {
    return JSON.parse(readFileSync(recordPath, 'utf8'))
  } catch {
    return undefined
  }
}

/** Resolve a job id to its session id; a session id passes through. */
function resolveSessionId(value) {
  if (!value.startsWith('job-')) return value
  const recordPath = jobRecordPath(value)
  const record = readJobState(recordPath)
  if (record === undefined || typeof record.sessionId !== 'string') {
    throw new Error(`no job record for ${value} — run this from the directory the job was started in`)
  }
  return record.sessionId
}

/** Buckets are named after the job's working directory. */
function logPathFor(sessionId) {
  const root = join(dshHome, 'sessions')
  for (const bucket of readdirSync(root)) {
    const candidate = join(root, bucket, sessionId, 'session.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`no session log for ${sessionId} under ${root}`)
}

/**
 * Decode complete frames at or after `offset`.
 * @returns parsed records plus the offset of the next frame boundary; a torn
 * trailing frame leaves the offset where it is, so the next poll retries it.
 */
async function decodeFrames(buffer, offset) {
  const records = []
  let cursor = offset
  for (;;) {
    if (cursor >= buffer.length) return { records, end: cursor }
    const stream = createZstdDecompress()
    const chunks = []
    const frame = await new Promise(resolve => {
      stream.on('data', chunk => chunks.push(chunk))
      stream.on('error', () => resolve({ ok: false, used: 0 }))
      stream.on('end', () => resolve({ ok: true, used: stream.bytesWritten }))
      stream.end(buffer.subarray(cursor))
    })
    if (!frame.ok || frame.used <= 0) return { records, end: cursor }
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text.endsWith('\n')) return { records, end: cursor }
    for (const line of text.split('\n')) {
      if (line === '') continue
      try {
        records.push(JSON.parse(line))
      } catch {
        // A frame is written atomically; unparsable lines mean a newer writer format.
      }
    }
    cursor += frame.used
  }
}

/** One readable activity line per record, or undefined when it carries none. */
function describe(record) {
  const data = record.data ?? {}
  if (record.type === 'tool/call') {
    let detail = data.arguments ?? ''
    try {
      const parsed = JSON.parse(data.arguments ?? '{}')
      detail = parsed.command ?? parsed.file_path ?? parsed.description ?? detail
    } catch {
      // Arguments that are not JSON stay verbatim.
    }
    return `tool ${data.name}: ${String(detail).replace(/\s+/g, ' ').slice(0, 160)}`
  }
  if (record.type === 'assistant/message') return 'assistant message'
  if (record.type === 'session/title') return undefined
  if (record.type === 'user/message') return 'user message'
  if (record.type === 'step/end') return `step ${data.step ?? '?'} end`
  if (record.type === 'turn/start') return 'turn start'
  return undefined
}

const jobId = target.startsWith('job-') ? target : undefined
const sessionId = resolveSessionId(target)
const logPath = logPathFor(sessionId)
const recordPath = jobId === undefined ? undefined : jobRecordPath(jobId)

const clock = time => new Date(time).toISOString().slice(11, 19)

const main = async () => {
  let offset = 0
  let emitted = 0
  let heartbeatAt = 0
  for (;;) {
    const { records, end } = await decodeFrames(readFileSync(logPath), offset)
    offset = end
    const activity = records
      .map(record => ({ time: record.time, text: describe(record) }))
      .filter(entry => entry.text !== undefined)
    const shown = watch ? activity : activity.slice(-lineCount)
    for (const entry of shown) {
      if (asJson) {
        console.log(JSON.stringify({ time: new Date(entry.time).toISOString(), text: entry.text }))
      } else {
        console.log(`${clock(entry.time)}  ${entry.text}`)
      }
    }
    emitted += shown.length
    // An idle job still needs a visible sign of life, but not one line per poll.
    const quiet = watch && records.length === 0 && Date.now() - heartbeatAt < IDLE_HEARTBEAT_MS
    if (!asJson && !quiet) {
      heartbeatAt = Date.now()
      console.log(`-- ${String(records.length)} new records at offset ${String(offset)} of ${String(readFileSync(logPath).length)} bytes, session ${sessionId}`)
    }
    if (!watch) {
      if (emitted === 0) console.log(`no activity yet in ${logPath}`)
      return
    }
    const job = readJobState(recordPath)
    if (job !== undefined && job.state !== 'running') {
      // A failed job's error carries its whole partial report; keep the line short
      // and point at the file that holds the rest.
      const detail = job.error === null || job.error === undefined
        ? ''
        : `: ${String(job.error).replace(/\s+/g, ' ').slice(0, 200)}`
      console.log(`-- job ${String(job.state)}${detail}`)
      if (recordPath !== undefined) console.log(`-- report: ${recordPath.replace(/\.json$/, '.result.md')}`)
      return
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

main().catch(error => {
  console.error(`session-tail: ${error.message}`)
  process.exit(1)
})
