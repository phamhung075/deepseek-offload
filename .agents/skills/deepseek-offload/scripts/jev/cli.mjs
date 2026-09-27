/**
 * Dispatch for `dsh-offload jev <sub>`. The runner passes the job-store helpers
 * it already owns, so this module never guesses where jobs live.
 *
 * All three subcommands are optional and skip cleanly without an API key:
 * Jev is a pre-screen for the orchestrator's review, never an approver.
 */
import { runReview } from './review.mjs'
import { runLint } from './lint.mjs'
import { runWatch } from './watch.mjs'
import { commandClaims } from './claims.mjs'
import { commandDecide, commandLog } from './decide.mjs'
import { commandTriage } from './triage.mjs'

/** Shown by `dsh-offload jev help` and appended to the runner's usage. */
export const JEV_USAGE = `  jev review <jobId> --repo DIR --base REV [--head REV] [--json]
  jev review --prompt-file F --repo DIR --base REV [--head REV] [--json]
                               pre-screen a job's diff against its work order;
                               hard rules first (neverTouch/pathScope), then
                               Jev; exit 3 when flagged, 0 when clean. Writes
                               <jobId>.jev-review.json beside the job record.
  jev lint --prompt-file F [--read-only] [--json]
                               brief, UNVALIDATED work-order check; advisory,
                               always exits 0. Enables start --jev-lint.
  jev watch <jobId> [--interval-ms N] [--timeout-ms N]
                               UNVALIDATED progress triage; exit 4 on a
                               looping/blocked/off-task verdict, 0 on settle.
                               Run it with run_in_background: true.
  jev claims <jobId> --repo DIR [--rev REV] [--json]
                               check the report's path:line claims against ±6
                               lines at REV (default HEAD); lists unsupported
                               claims (threshold 0.3). Never flags the diff.
  jev decide <jobId> accept|reject|partial [--note TEXT] [--json]
                               record a label and append it to jev-log.jsonl
                               (pure local; no key needed).
  jev log [--json]             decision counts and flagged/clean agreement,
                               with a P(none) what-if at 0.4/0.5/0.6.
  jev triage <jobId> [--json]  failure triage: code rules first, then one
                               UNVALIDATED Jev failure_kind when no rule
                               matches. Never auto-resumes.
                             Auto-review is configured on start/resume with
                             --review-repo DIR (or DSH_OFFLOAD_REVIEW_REPO); the
                             worker runs it when the job settles and result/wait
                             print the stored block (--jev-exit exits 3 on a
                             flagged review). wait --jev-watch stops early on a
                             confident watch problem.
                             Jev is optional (TYPESAFE_API_KEY or
                             TYPESAFE_AI_API; endpoint TYPESAFE_API_URL).
                             It is a pre-screen — the orchestrator still
                             reviews every diff.
`

/**
 * Run one `jev` subcommand.
 * @param positional - `[sub, ...args]` from the runner's argument parser.
 * @param flags - parsed flags.
 * @param ctx - `{readJob, loadJob, isActive, jobsDir, writeJsonAtomic,
 *   projectRoot, sessionTail, env, stdout, stderr}` supplied by the runner.
 * @returns process exit code.
 */
export async function runJevCli(positional, flags, ctx) {
  const sub = positional[0]
  const rest = positional.slice(1)
  switch (sub) {
    case 'review':
      return runReview(rest, flags, ctx)
    case 'lint':
      return runLint(rest, flags, ctx)
    case 'watch':
      return runWatch(rest, flags, ctx)
    case 'claims':
      return commandClaims(rest, flags, ctx)
    case 'decide':
      return commandDecide(rest, flags, ctx)
    case 'log':
      return commandLog(rest, flags, ctx)
    case 'triage':
      return commandTriage(rest, flags, ctx)
    case undefined:
    case 'help':
    case '--help':
      ctx.stdout.write(JEV_USAGE)
      return 0
    default:
      ctx.stderr.write(`dsh-offload: unknown jev subcommand: ${sub}\n`)
      ctx.stdout.write(JEV_USAGE)
      return 1
  }
}
