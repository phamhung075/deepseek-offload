/**
 * The project rules file: one file per repository that every offloaded job
 * reads before its task, so the caller's prompt carries only the job itself.
 *
 * Convention: `<git toplevel of the job's cwd>/.agents/offload-rules.md`. A
 * linked worktree resolves to its own top level, so a job reads the copy on the
 * branch it works on. When the file exists, `start` and `resume` prepend one
 * line naming its absolute path; when it does not, the prompt is unchanged.
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PROJECT_RULES_RELATIVE = path.join('.agents', 'offload-rules.md')

/** The git top level of `cwd`, or null when `cwd` is not inside a work tree. */
export function gitTopLevel(cwd) {
  const out = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' })
  if (out.status !== 0 || typeof out.stdout !== 'string') return null
  const top = out.stdout.trim()
  return top === '' ? null : top
}

/**
 * The rules file for `cwd`, or null when there is none.
 * @returns `{ path, sha256 }` of the file's current content.
 */
export function findProjectRules(cwd) {
  const top = gitTopLevel(cwd)
  if (top === null) return null
  const file = path.join(top, PROJECT_RULES_RELATIVE)
  let content
  try {
    if (!fs.statSync(file).isFile()) return null
    content = fs.readFileSync(file)
  } catch {
    return null
  }
  return { path: file, sha256: crypto.createHash('sha256').update(content).digest('hex') }
}

/** The one line a job's prompt starts with when its project has a rules file. */
export function projectRulesLine(file) {
  return `Before anything else, read ${file} in full and follow it; it is this project's contract for every job.`
}

/**
 * The prompt the child receives, and what was included.
 * @param prompt - the prompt the caller composed.
 * @param cwd - the job's working directory.
 * @param options.skip - `--no-project-rules`: leave the prompt alone.
 * @returns `{ prompt, projectRules }`, `projectRules` null when nothing was included.
 */
export function applyProjectRules(prompt, cwd, { skip = false } = {}) {
  if (skip) return { prompt, projectRules: null }
  const rules = findProjectRules(cwd)
  if (rules === null) return { prompt, projectRules: null }
  return { prompt: `${projectRulesLine(rules.path)}\n\n${prompt}`, projectRules: rules }
}

/** The `rules` line of a job's status and result header. */
export function describeProjectRules(job) {
  if (job.projectRules && typeof job.projectRules.path === 'string') {
    return `rules     ${job.projectRules.path} sha256=${job.projectRules.sha256}`
  }
  if (job.projectRulesSkipped === true) return 'rules     not included (--no-project-rules)'
  return 'rules     none (no .agents/offload-rules.md at the git top level of cwd)'
}
