/**
 * Where a job worker's update socket lives.
 *
 * A Unix socket path must fit `sun_path`: 108 bytes on Linux and 104 on macOS,
 * NUL included. The socket sits next to the job record by default, but a job
 * store under a deep checkout (a 4genthub seat worktree such as
 * ~/.config/4genthub/rooms/<room>/wt/<seat>/<repo>/scratch/dsh-offload/jobs)
 * overflows it, and `listen` fails with EINVAL. Such a job gets its socket in a
 * short private directory instead, and the worker records the path in the job
 * record so `update` and `cancel` find it.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The longest socket path, in bytes, that binds on both Linux and macOS. */
export const SOCKET_PATH_MAX = 103

/**
 * Create (if needed) and vet a private socket directory: a real directory,
 * not a symlink, owned by this user, with no group or other access.
 * @returns true when the directory is safe to use.
 */
function privateDir(dir, uid) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = fs.lstatSync(dir)
    if (!stat.isDirectory()) return false
    if (uid !== undefined && stat.uid !== uid) return false
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700)
    return (fs.lstatSync(dir).mode & 0o077) === 0
  } catch {
    return false
  }
}

/**
 * The short socket directories to try, in order: `$XDG_RUNTIME_DIR/dsh-offload`,
 * then `<tmpdir>/dsh-offload-<uid>`, then `/tmp/dsh-offload-<uid>`.
 */
function shortDirCandidates({ runtimeDir, tmpDir, uid }) {
  const suffix = uid === undefined ? 'dsh-offload' : `dsh-offload-${uid}`
  const dirs = []
  if (typeof runtimeDir === 'string' && runtimeDir !== '') dirs.push(path.join(runtimeDir, 'dsh-offload'))
  if (typeof tmpDir === 'string' && tmpDir !== '') dirs.push(path.join(tmpDir, suffix))
  dirs.push(path.join('/tmp', suffix))
  return [...new Set(dirs)]
}

/**
 * The socket path for a job.
 * @param jobsDir - the job store directory that holds `<jobId>.json`.
 * @param jobId - the job id.
 * @param options - overrides for tests: `max`, `runtimeDir`, `tmpDir`, `uid`.
 * @returns `<jobsDir>/<jobId>.sock` when it fits, else a path in a short
 *   private directory, prefixed with a hash of the job store so two projects'
 *   jobs of the same id never share a socket.
 */
export function jobSocketPath(jobsDir, jobId, options = {}) {
  const max = options.max ?? SOCKET_PATH_MAX
  const preferred = path.join(jobsDir, `${jobId}.sock`)
  if (Buffer.byteLength(preferred) <= max) return preferred

  const uid = 'uid' in options ? options.uid : (typeof process.getuid === 'function' ? process.getuid() : undefined)
  const runtimeDir = 'runtimeDir' in options ? options.runtimeDir : process.env.XDG_RUNTIME_DIR
  const tmpDir = 'tmpDir' in options ? options.tmpDir : os.tmpdir()
  const store = crypto.createHash('sha256').update(path.resolve(jobsDir)).digest('hex').slice(0, 8)
  const name = `${store}-${jobId}.sock`
  for (const dir of shortDirCandidates({ runtimeDir, tmpDir, uid })) {
    const candidate = path.join(dir, name)
    if (Buffer.byteLength(candidate) > max) continue
    if (privateDir(dir, uid)) return candidate
  }
  throw new Error(
    `no socket path within ${max} bytes for job ${jobId}: ${preferred} is too long and no short private directory is usable ` +
      '(set XDG_RUNTIME_DIR or TMPDIR to a short writable directory)',
  )
}
