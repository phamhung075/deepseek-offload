/**
 * Machine-wide index of job stores.
 *
 * A job's record lives under the directory the `start` caller ran from
 * (`<project>/scratch/dsh-offload/jobs`), so `wait`, `status` or `result` run
 * from any other directory used to answer "unknown job id" for a live job
 * (observed 2026-11-07: started from ~/w/job, waited on from ~/projects/aa2-rs).
 * Every new job appends one line here naming its store, and a lookup that
 * misses the local store follows the index to the right one.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Rewrite the index without dead entries once it grows past this size. */
const COMPACT_BYTES = 1024 * 1024

/**
 * Where the index lives: `$DSH_OFFLOAD_INDEX`, else the XDG state directory.
 * @returns absolute path of the JSON Lines index file.
 */
export function jobIndexFile() {
  if (process.env.DSH_OFFLOAD_INDEX) return process.env.DSH_OFFLOAD_INDEX
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
  return path.join(state, 'dsh-offload', 'job-index.jsonl')
}

function readEntries(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const entries = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry && typeof entry.jobId === 'string' && typeof entry.jobRoot === 'string') entries.push(entry)
    } catch {
      /* a torn line from a concurrent append: skip it */
    }
  }
  return entries
}

function recordPath(jobRoot, jobId) {
  return path.join(jobRoot, 'jobs', `${jobId}.json`)
}

/**
 * Note that `jobId` is stored under `jobRoot`. Best effort: a failure here
 * never stops a job from starting.
 * @param jobId - the new job's id.
 * @param jobRoot - absolute job root (the parent of its `jobs/` directory).
 * @param projectRoot - the project root the job's runner used.
 */
export function recordJobStore(jobId, jobRoot, projectRoot) {
  const file = jobIndexFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = `${JSON.stringify({ jobId, jobRoot: path.resolve(jobRoot), projectRoot: path.resolve(projectRoot), at: Date.now() })}\n`
    fs.appendFileSync(file, line)
    if (fs.statSync(file).size > COMPACT_BYTES) {
      const live = readEntries(file).filter((entry) => fs.existsSync(recordPath(entry.jobRoot, entry.jobId)))
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, live.map((entry) => JSON.stringify(entry)).join('\n') + (live.length ? '\n' : ''))
      fs.renameSync(tmp, file)
    }
  } catch {
    /* the index is a convenience; the job record is the source of truth */
  }
}

/**
 * Find the store that holds `jobId`: the index entry for it, else any store
 * the index knows that has the record (jobs started before the index existed,
 * from a directory that later jobs also used).
 * @param jobId - the job id to find.
 * @param exclude - a job root already searched (the caller's own).
 * @returns `{ jobRoot, projectRoot }`, or null when no known store has it.
 */
export function lookupJobStore(jobId, exclude) {
  const entries = readEntries(jobIndexFile())
  const skip = exclude ? path.resolve(exclude) : null
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry.jobId !== jobId || entry.jobRoot === skip) continue
    if (fs.existsSync(recordPath(entry.jobRoot, jobId))) return { jobRoot: entry.jobRoot, projectRoot: entry.projectRoot || path.dirname(path.dirname(entry.jobRoot)) }
  }
  const seen = new Set(skip ? [skip] : [])
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (seen.has(entry.jobRoot)) continue
    seen.add(entry.jobRoot)
    if (fs.existsSync(recordPath(entry.jobRoot, jobId))) return { jobRoot: entry.jobRoot, projectRoot: entry.projectRoot || path.dirname(path.dirname(entry.jobRoot)) }
  }
  return null
}
