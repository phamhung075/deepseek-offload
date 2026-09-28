/**
 * Git diff collection and hunk splitting for `jev review`.
 *
 * A "group" is one commit in `BASE..HEAD`, the working tree's uncommitted
 * changes (`git diff HEAD`, tracked files only), or the untracked files. Each
 * group is an ordered list of hunks, each carrying its file and its `@@` header
 * so a flagged range can be pointed at precisely. Binary hunks and lockfiles are
 * dropped; each hunk is truncated so one large file cannot crowd out the rest of
 * the request.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Truncate one hunk so a single large file cannot dominate a request. */
export const MAX_HUNK_CHARS = 4000
export const TRUNCATION_MARKER = '\n...[TRUNCATED]'

/**
 * Split a group larger than this into several choice requests. This is the
 * measured group size: the evaluation capped each group at 7 hunks
 * (6 own + 1 smuggled); larger groups were not measured.
 */
export const MAX_HUNKS_PER_REQUEST = 7

/** Generated dependency files never carry a meaningful scope judgment. */
export const LOCKFILES = new Set(['package-lock.json', 'Cargo.lock', 'go.sum', 'yarn.lock', 'pnpm-lock.yaml'])

/** Synthetic group identity for the untracked-files group. */
export const UNTRACKED_SHA = 'untracked'
export const UNTRACKED_SUBJECT = 'untracked files'

/**
 * Synthetic group identity for the working-tree group: tracked files with
 * staged and/or unstaged changes, compared to HEAD so commits in `BASE..HEAD`
 * are never counted twice. It is rendered as `worktree` in the review block,
 * and its subject is deliberately the state, not a commit.
 */
export const WORKTREE_SHA = 'worktree'
export const WORKTREE_SUBJECT = 'uncommitted changes'

/** What a review covers: every commit in range, or only uncommitted + untracked. */
export const SCOPE_ALL = 'all'
export const SCOPE_UNCOMMITTED = 'uncommitted'
export const REVIEW_SCOPES = [SCOPE_ALL, SCOPE_UNCOMMITTED]

const HEAD = 'HEAD'
const GIT_MAX_BUFFER = 64 * 1024 * 1024

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER })
}

const diffPath = (line) => (line.match(/^diff --git a\/(.+) b\/(.+)$/) ?? [null, null, 'unknown'])[2]

/** Added/removed lines in a hunk body (the `@@` header is line 0). */
export function countChangedLines(lines) {
  let count = 0
  for (let index = 1; index < lines.length; index++) {
    const marker = lines[index][0]
    if (marker === '+' || marker === '-') count++
  }
  return count
}

function isLockfile(file) {
  return LOCKFILES.has(file.split('/').pop())
}

/** A byte buffer is binary when it carries a NUL, the same test git uses. */
function isBinaryBuffer(buffer) {
  return buffer.includes(0)
}

/**
 * Split one diff text into hunks carrying their file and `@@` header.
 * @param diffText - `git show`/`git diff` output.
 * @returns `{file, range, text, truncated, changed_lines}[]`, binary and lockfiles removed.
 */
export function splitHunks(diffText) {
  const hunks = []
  let file = null
  let current = null
  const flush = () => {
    if (current === null) return
    if (!isLockfile(current.file) && !current.binary) {
      let text = `${current.header}\n${current.lines.join('\n')}`
      let truncated = false
      if (text.length > MAX_HUNK_CHARS) {
        text = text.slice(0, MAX_HUNK_CHARS) + TRUNCATION_MARKER
        truncated = true
      }
      hunks.push({
        file: current.file,
        range: current.range,
        text,
        truncated,
        changed_lines: countChangedLines(current.lines),
      })
    }
    current = null
  }
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      file = diffPath(line)
    } else if (line.startsWith('@@')) {
      flush()
      current = { file, header: `diff --git a/${file} b/${file}`, range: line, lines: [line], binary: false }
    } else if (current !== null) {
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) current.binary = true
      current.lines.push(line)
    }
  }
  flush()
  return hunks
}

const shasInRange = (repo, base, head) => git(repo, ['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean)
const commitSubject = (repo, sha) => git(repo, ['show', '-s', '--format=%s', sha]).trim()
const commitDiff = (repo, sha) => git(repo, ['show', '--no-color', '--format=', '--unified=3', sha])

/** Repo-relative untracked files (respecting `.gitignore`). */
export function untrackedFiles(repo) {
  return git(repo, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)
}

/**
 * The uncommitted changes of tracked files relative to `head` (staged and
 * unstaged together), split into hunks. `git diff HEAD` is used so a commit
 * already in `BASE..HEAD` is not reviewed twice.
 * @returns the synthetic `worktree` group, or null when nothing changed.
 */
export function worktreeGroup(repo, head = HEAD) {
  const hunks = splitHunks(git(repo, ['diff', '--no-color', '--unified=3', head]))
  if (hunks.length === 0) return null
  return { kind: 'worktree', sha: WORKTREE_SHA, subject: WORKTREE_SUBJECT, hunks }
}

/**
 * Turn one untracked file into a synthetic new-file hunk, or null when it is a
 * lockfile, binary, unreadable, or empty.
 * @param repo - absolute repository path.
 * @param file - repo-relative path.
 */
export function untrackedHunk(repo, file) {
  if (isLockfile(file)) return null
  let buffer
  try {
    buffer = fs.readFileSync(path.join(repo, file))
  } catch {
    return null
  }
  if (buffer.length === 0 || isBinaryBuffer(buffer)) return null
  const lines = buffer.toString('utf8').replace(/\n$/, '').split('\n')
  const header = `diff --git a/${file} b/${file}`
  const body = [
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ]
  let text = `${header}\n${body.join('\n')}`
  let truncated = false
  if (text.length > MAX_HUNK_CHARS) {
    text = text.slice(0, MAX_HUNK_CHARS) + TRUNCATION_MARKER
    truncated = true
  }
  return {
    file,
    range: `@@ -0,0 +1,${lines.length} @@`,
    text,
    truncated,
    changed_lines: lines.length,
  }
}

/**
 * Collect the review groups: one per commit in `base..head` with at least one
 * hunk (unless `scope` is `uncommitted`), then the uncommitted tracked changes,
 * then the untracked files. The worktree group is added only when `head` is
 * `HEAD`, so a historical range never includes the working tree.
 * @returns `{kind, sha, subject, hunks}[]`; commits first, untracked last.
 */
export function buildGroups({ repo, base, head = HEAD, scope = SCOPE_ALL }) {
  const groups = []
  if (scope !== SCOPE_UNCOMMITTED) {
    for (const sha of shasInRange(repo, base, head)) {
      const hunks = splitHunks(commitDiff(repo, sha))
      if (hunks.length === 0) continue
      groups.push({ kind: 'commit', sha, subject: commitSubject(repo, sha), hunks })
    }
  }
  if (head === HEAD) {
    const worktree = worktreeGroup(repo, head)
    if (worktree !== null) groups.push(worktree)
  }
  const untracked = untrackedFiles(repo).map((file) => untrackedHunk(repo, file)).filter(Boolean)
  if (untracked.length > 0) {
    groups.push({ kind: 'untracked', sha: UNTRACKED_SHA, subject: UNTRACKED_SUBJECT, hunks: untracked })
  }
  return groups
}

/** Split a group's hunks into requests of at most `size` hunks. */
export function chunkHunks(hunks, size = MAX_HUNKS_PER_REQUEST) {
  const chunks = []
  for (let index = 0; index < hunks.length; index += size) chunks.push(hunks.slice(index, index + size))
  return chunks
}
