/**
 * The one reader of a `--prompt-file` work order, shared by `jev review`,
 * `jev lint`, `jev route` and `jev skills`.
 *
 * The flag is named `--prompt-file` or its short `-f`; the single-argument
 * commands also accept the file as the first positional. The read itself, and
 * the error line it prints, are identical in every command.
 */
import fs from 'node:fs'

/**
 * Resolve the prompt file: `--prompt-file`, then `-f`, then an optional
 * positional argument. Returns null when none was given.
 */
export function resolvePromptFile(flags, positional = []) {
  if (typeof flags['prompt-file'] === 'string') return flags['prompt-file']
  if (typeof flags.f === 'string') return flags.f
  return positional[0] ?? null
}

/**
 * Read a prompt file, writing the one canonical error line on failure.
 * @returns the trimmed text, or null after writing to `ctx.stderr`.
 */
export function readPromptFile(promptFile, ctx) {
  try {
    return fs.readFileSync(promptFile, 'utf8').trim()
  } catch (error) {
    ctx.stderr.write(`dsh-offload: cannot read --prompt-file: ${error.message}\n`)
    return null
  }
}
