/**
 * The one reader of a work order's text for the background runner: `start`'s
 * prompt, `resume`'s extra instructions and `update`'s message all come through
 * `readPromptText`, so the file and stdin forms behave the same on every command.
 *
 * The flag is named `--prompt-file` or its short `-f`; a lone `-` positional
 * reads stdin. Both keep text with backticks or code fences out of the shell,
 * which would evaluate a backtick span as command substitution before the
 * runner ever saw it.
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
 * Read a command's text from its words, its `--prompt-file`/`-f`, or stdin.
 *
 * @param flags - the parsed flags.
 * @param words - the positional words that form the text (job id already removed).
 * @param options.fail - called with a user-facing message; must not return.
 * @param options.implicitStdin - also read stdin when no text was given and
 *   stdin is not a TTY (`start` only: an optional text, as on `resume`, must
 *   not block on an inherited stdin that never closes).
 * @param options.readStdin - stdin reader, replaceable in tests.
 * @param options.stdinIsTTY - whether stdin is a terminal, replaceable in tests.
 * @returns the trimmed text, '' when none was given.
 */
export function readPromptText(flags, words, {
  fail,
  implicitStdin = false,
  readStdin = () => fs.readFileSync(0, 'utf8'),
  stdinIsTTY = process.stdin.isTTY,
} = {}) {
  const file = resolvePromptFile(flags)
  const text = words.join(' ').trim()
  if (file !== null) {
    if (text !== '') fail(`give the text either as an argument or with --prompt-file, not both (got --prompt-file ${file} and "${text}")`)
    if (!fs.existsSync(file)) fail(`prompt file not found: ${file}`)
    return fs.readFileSync(file, 'utf8').trim()
  }
  if (text === '-' || (implicitStdin && text === '' && !stdinIsTTY)) return readStdin().trim()
  return text
}
