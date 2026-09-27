/**
 * The one reader of a job's stored result text, shared by `jev claims`,
 * `jev conflicts` and the automatic review.
 *
 * `dsh-offload.mjs` stores the result both beside the job record
 * (`<jobsDir>/<jobId>.result.md`) and on the record as `resultFile` relative to
 * the project root. Reading prefers the recorded path and falls back to the
 * default file, so a project that moved still resolves.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The default result file beside the job record. */
export function resultFile(jobsDir, jobId) {
  return path.join(jobsDir, `${jobId}.result.md`)
}

/**
 * The result text of one job, or '' when it has none.
 * @param jobId - the job.
 * @param job - its record; a recorded `resultFile` is preferred when present.
 * @param ctx - `{jobsDir, projectRoot}`.
 */
export function readResultText(jobId, job, ctx = {}) {
  const candidates = []
  if (typeof job?.resultFile === 'string' && job.resultFile !== ''
    && typeof ctx.projectRoot === 'string' && ctx.projectRoot !== '') {
    candidates.push(path.resolve(ctx.projectRoot, job.resultFile))
  }
  if (typeof ctx.jobsDir === 'string' && ctx.jobsDir !== '') candidates.push(resultFile(ctx.jobsDir, jobId))
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
    } catch {
      /* try the next candidate */
    }
  }
  return ''
}
