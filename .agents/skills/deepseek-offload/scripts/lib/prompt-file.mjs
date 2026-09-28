/**
 * The one resolver of a `--prompt-file` work order for the background runner.
 *
 * The flag is named `--prompt-file` or its short `-f`; callers that accept the
 * file as the first positional pass their positional arguments in.
 */

/**
 * Resolve the prompt file: `--prompt-file`, then `-f`, then an optional
 * positional argument. Returns null when none was given.
 */
export function resolvePromptFile(flags, positional = []) {
  if (typeof flags['prompt-file'] === 'string') return flags['prompt-file']
  if (typeof flags.f === 'string') return flags.f
  return positional[0] ?? null
}
