/**
 * How long `wait` blocks when the caller gives no `--timeout-ms`: as long as the
 * job itself may run, so a backgrounded waiter's exit means the job ended.
 */

/** Exit code of a `wait` that gave up while the job still runs; 0 and 1 mean the job settled. */
export const WAIT_TIMED_OUT_EXIT = 2

/** Slack past the worker's own bound, so `wait` never gives up before the worker does. */
export const WAIT_MARGIN_MS = 2 * 60_000

/**
 * When a job must have settled: the worker gives its turn `timeoutMs` plus the
 * bridge boot grace, counted from the start, or from the off-peak wake of a deferred job.
 * @param job - job record read from disk (`startedAt`, `timeoutMs`, optional `deferredUntil`).
 * @param now - current time in ms.
 * @param bounds - `defaultTimeoutMs` for a record without `timeoutMs`, and the worker's `bootGraceMs`.
 * @returns the deadline in ms, never earlier than `now + WAIT_MARGIN_MS`.
 */
export function jobSettleDeadline(job, now, { defaultTimeoutMs, bootGraceMs }) {
  const started = typeof job.startedAt === 'number' ? job.startedAt : now
  const begin = typeof job.deferredUntil === 'number' ? Math.max(started, job.deferredUntil) : started
  const timeoutMs = typeof job.timeoutMs === 'number' ? job.timeoutMs : defaultTimeoutMs
  return Math.max(begin + timeoutMs + bootGraceMs + WAIT_MARGIN_MS, now + WAIT_MARGIN_MS)
}
