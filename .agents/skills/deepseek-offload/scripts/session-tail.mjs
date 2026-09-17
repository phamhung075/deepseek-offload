#!/usr/bin/env node
/**
 * Print the live tail of a DeepSeek Harness session log.
 *
 * The web GUI cannot show a session another process is running — an offload
 * job runs in the separate `dsh --profile acp` child the bridge spawns — so
 * this reads the durable log directly. The log is an append-only Zstandard
 * stream with one frame per append and JSONL inside each frame, so every frame
 * must be walked: one `zstdDecompressSync` call returns only the first frame.
 *
 * A Session directory holds one file per format generation: `session.v3.jsonl.zstd`
 * for the current format, `session.jsonl.zstd` for the first, and the same names
 * without `.zstd` when the profile stores logs uncompressed. This prints the
 * numerically highest generation, which is the live one — an earlier generation
 * left beside it is frozen and never grows. `session.vN.stream.jsonl` is the live
 * frame channel rather than a log generation, so resolution never picks it.
 *
 * `--watch` also prints the Assistant text published on that channel, so a turn
 * is readable while it runs instead of only when it settles. Only frames
 * published after the watch starts are printed; the durable log carries the
 * earlier activity.
 *
 * Usage:
 *   node session-tail.mjs <jobId|sessionId> [--lines N] [--watch] [--json]
 *                          [--no-text] [--interval-ms N]
 *
 * `--watch` polls and prints each new activity line, then exits when the job
 * record stops reading `running`.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const target = args.find(argument => !argument.startsWith('--'))
if (target === undefined || target === '') {
  console.error('usage: session-tail.mjs <jobId|sessionId> [--lines N] [--watch] [--json] [--no-text] [--interval-ms N]')
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

/** One durable log filename: `session.jsonl` (v0) or `session.vN.jsonl`, each optionally `.zstd`. */
const LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

const NEWLINE = 0x0A

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

/**
 * Parse one durable log filename into its generation and encoding.
 * The version token sits directly before the suffix, so a side channel such as
 * `session.v3.stream.jsonl` never parses as a log generation.
 * @returns the generation and encoding, or undefined for any other file.
 */
function parseLogName(name) {
  const match = LOG_NAME.exec(name)
  if (match === null) return undefined
  const version = match[1] === undefined ? 0 : Number(match[1])
  if (!Number.isSafeInteger(version)) return undefined
  return { version, compression: match[2] === undefined ? 'none' : 'zstd' }
}

/** The live frame channel beside one durable generation. */
function streamChannelPath(logPath) {
  for (const suffix of ['.jsonl.zstd', '.jsonl']) {
    if (logPath.endsWith(suffix)) return `${logPath.slice(0, -suffix.length)}.stream.jsonl`
  }
  throw new Error(`session log path does not carry a JSONL suffix: "${logPath}"`)
}

/**
 * Locate the newest durable generation for a session id across project buckets.
 * @returns the log path, its encoding, and the side-channel path beside it.
 * @throws when no bucket holds a log for that id.
 */
function sessionLog(sessionId) {
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
      .map(name => ({ name, ...parseLogName(name) }))
      .filter(entry => entry.version !== undefined)
      .sort((left, right) => right.version - left.version || (left.compression === 'zstd' ? -1 : 1))[0]
    if (newest === undefined) continue
    const logPath = join(dir, newest.name)
    return { logPath, compression: newest.compression, streamPath: streamChannelPath(logPath) }
  }
  throw new Error(
    `no session log for ${sessionId} under ${root}`
    + ' — looked for session.vN.jsonl.zstd, session.vN.jsonl, session.jsonl.zstd, or session.jsonl',
  )
}

/** Read the bytes appended since `offset`, or none while the file is absent. */
function readAppended(path, offset) {
  let size
  try {
    size = statSync(path).size
  } catch {
    // The publishing process creates the channel with its first frame.
    return { bytes: Buffer.alloc(0), offset }
  }
  // A channel that shrank was repaired by a new writer, so its tail restarts here.
  const start = size < offset ? 0 : offset
  if (size === start) return { bytes: Buffer.alloc(0), offset: start }
  const handle = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(size - start)
    const read = readSync(handle, buffer, 0, buffer.length, start)
    return { bytes: buffer.subarray(0, read), offset: start + read }
  } finally {
    closeSync(handle)
  }
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

/** Decode complete plaintext rows at or after `offset` from an uncompressed log. */
function decodeLines(buffer, offset) {
  const records = []
  let cursor = offset
  for (;;) {
    const newline = buffer.indexOf(NEWLINE, cursor)
    if (newline === -1) return { records, end: cursor }
    const line = buffer.subarray(cursor, newline).toString('utf8')
    cursor = newline + 1
    if (line === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A row is written atomically; unparsable lines mean a newer writer format.
    }
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
const { logPath, compression, streamPath } = sessionLog(sessionId)
const recordPath = jobId === undefined ? undefined : jobRecordPath(jobId)
const textFrames = !args.includes('--no-text')

const clock = time => new Date(time).toISOString().slice(11, 19)

/** Attempt whose Assistant text is still open on stdout, if any. */
let openAttempt
/** Byte offset consumed from the live frame channel. */
let streamOffset = readAppended(streamPath, 0).offset
/** Bytes of the frame channel that do not yet form a complete record. */
let streamCarry = Buffer.alloc(0)
/** Frame records read from the channel, reported in the heartbeat. */
let liveFrames = 0

/** End the open Assistant text line so the next line starts on its own. */
function closeText() {
  if (openAttempt === undefined) return
  openAttempt = undefined
  if (!asJson) process.stdout.write('\n')
}

/** Print one durable activity line. */
function emitActivity(entry) {
  closeText()
  if (asJson) {
    console.log(JSON.stringify({ time: new Date(entry.time).toISOString(), text: entry.text }))
  } else {
    console.log(`${clock(entry.time)}  ${entry.text}`)
  }
}

/** Print one live frame record, streaming Assistant text as it arrives. */
function emitLiveFrame(record) {
  const frame = record.frame
  const chunk = frame?.type === 'chunk' ? frame.chunk : undefined
  if (frame?.type !== 'chunk' || chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') {
    // Reasoning and tool-call fragments end the text block they interrupted.
    closeText()
    return
  }
  if (openAttempt !== frame.attemptId) {
    closeText()
    openAttempt = frame.attemptId
    if (!asJson) process.stdout.write(`${clock(frame.time)}  assistant: `)
  }
  if (asJson) {
    console.log(
      JSON.stringify({ time: new Date(frame.time).toISOString(), type: 'assistant-text', text: chunk.text }),
    )
  } else {
    process.stdout.write(chunk.text)
  }
}

/** Read and print the frame records appended to the channel since the last poll. */
function readLiveFrames() {
  const appended = readAppended(streamPath, streamOffset)
  streamOffset = appended.offset
  if (appended.bytes.length === 0) return
  const buffer = streamCarry.length === 0 ? appended.bytes : Buffer.concat([streamCarry, appended.bytes])
  const lastNewline = buffer.lastIndexOf(NEWLINE)
  if (lastNewline === -1) {
    streamCarry = buffer
    return
  }
  streamCarry = buffer.subarray(lastNewline + 1)
  for (const line of buffer.subarray(0, lastNewline).toString('utf8').split('\n')) {
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      // A frame is written atomically; unparsable lines mean a newer writer format.
      continue
    }
    liveFrames += 1
    emitLiveFrame(record)
  }
}

const main = async () => {
  let offset = 0
  let emitted = 0
  let heartbeatAt = 0
  for (;;) {
    const logBytes = readFileSync(logPath)
    const { records, end } = compression === 'zstd'
      ? await decodeFrames(logBytes, offset)
      : decodeLines(logBytes, offset)
    offset = end
    const activity = records
      .map(record => ({ time: record.time, text: describe(record) }))
      .filter(entry => entry.text !== undefined)
    const shown = watch ? activity : activity.slice(-lineCount)
    for (const entry of shown) emitActivity(entry)
    emitted += shown.length
    if (watch && textFrames) readLiveFrames()
    // An idle job still needs a visible sign of life, but not one line per poll.
    const quiet = watch && records.length === 0 && Date.now() - heartbeatAt < IDLE_HEARTBEAT_MS
    if (!asJson && !quiet) {
      heartbeatAt = Date.now()
      closeText()
      const live = textFrames && liveFrames > 0
        ? `, ${String(liveFrames)} live frames at ${String(streamOffset)} stream bytes`
        : ''
      console.log(`-- ${String(records.length)} new records at offset ${String(offset)} of ${String(logBytes.length)} bytes${live}, session ${sessionId}`)
    }
    if (!watch) {
      if (emitted === 0) console.log(`no activity yet in ${logPath}`)
      return
    }
    const job = readJobState(recordPath)
    if (job !== undefined && job.state !== 'running') {
      // A failed job's error carries its whole partial report; keep the line short
      // and point at the file that holds the rest.
      closeText()
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
