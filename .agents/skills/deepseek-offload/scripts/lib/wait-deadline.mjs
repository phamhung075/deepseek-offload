/**
 * The job's wall-clock bound, and how long `wait` blocks when the caller gives no
 * `--timeout-ms`: as long as the job itself may run, so a backgrounded waiter's exit
 * means the job ended.
 */

/** Exit code of a `wait` that gave up while the job still runs; 0 and 1 mean the job settled. */
export const WAIT_TIMED_OUT_EXIT = 2

/** Slack past the worker's own bound, so `wait` never gives up before the worker does. */
export const WAIT_MARGIN_MS = 2 * 60_000

/** Longest head start the worker's stop takes before the wall-clock deadline. */
export const MAX_STOP_LEAD_MS = 30_000

/**
 * When the job's run begins: its start, or the off-peak wake of a deferred job.
 * @param job - job record (`startedAt`, optional `deferredUntil`).
 * @param now - fallback for a record without `startedAt`.
 * @returns the begin time in ms.
 */
export function jobRunBegin(job, now) {
  const started = typeof job.startedAt === 'number' ? job.startedAt : now
  return typeof job.deferredUntil === 'number' ? Math.max(started, job.deferredUntil) : started
}

/**
 * The job's wall-clock deadline: `timeoutMs` after its run begins, boot included.
 * The worker has stopped the agent and recorded `timed_out` by then.
 * @param job - job record (`startedAt`, `timeoutMs`, optional `deferredUntil`).
 * @param now - fallback for a record without `startedAt`.
 * @param defaultTimeoutMs - bound for a record without `timeoutMs`.
 * @returns the deadline in ms.
 */
export function jobWallDeadline(job, now, defaultTimeoutMs) {
  const timeoutMs = typeof job.timeoutMs === 'number' ? job.timeoutMs : defaultTimeoutMs
  return jobRunBegin(job, now) + timeoutMs
}

/**
 * How long before the deadline the worker starts stopping: the first half asks the
 * session to cancel (keeping its partial answer), the second half kills the bridge.
 * @param timeoutMs - the job's bound.
 * @returns the lead in ms, 5 % of the bound within [200 ms, `MAX_STOP_LEAD_MS`].
 */
export function stopLeadMs(timeoutMs) {
  return Math.min(MAX_STOP_LEAD_MS, Math.max(200, Math.floor(timeoutMs / 20)))
}

/**
 * When a job must have settled: its wall-clock deadline, plus a margin.
 * @param job - job record read from disk (`startedAt`, `timeoutMs`, optional `deferredUntil`).
 * @param now - current time in ms.
 * @param bounds - `defaultTimeoutMs` for a record without `timeoutMs`.
 * @returns the deadline in ms, never earlier than `now + WAIT_MARGIN_MS`.
 */
export function jobSettleDeadline(job, now, { defaultTimeoutMs }) {
  return Math.max(jobWallDeadline(job, now, defaultTimeoutMs) + WAIT_MARGIN_MS, now + WAIT_MARGIN_MS)
}
