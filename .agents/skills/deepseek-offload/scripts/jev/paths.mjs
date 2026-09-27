/**
 * The one definition of "what looks like a source path" in Jev text: the
 * measured citation extension list and the two regexes built from it.
 *
 * `jev claims` reads a `path:line` citation together with its sentence;
 * `jev conflicts` reads any cited path to prefilter findings across jobs. The
 * extraction output differs, but the path grammar must not: sharing the
 * extension list keeps a wording or threshold measured on one true for the
 * other.
 */

/** The measured citation extension list; it keeps URLs and prose out. */
export const SOURCE_EXTENSIONS =
  'go|rs|ts|tsx|js|jsx|mjs|cjs|py|sh|bash|yml|yaml|toml|json|sql|proto|md|mod|conf|cfg|ini|css|html|xml|txt'

/** A source path, without a line suffix and without capture groups. */
const PATH_BODY = `[A-Za-z0-9_@][A-Za-z0-9_@./-]*\\.(?:${SOURCE_EXTENSIONS})`

/** Every cited source path, with an optional `:line` / `:~line` suffix. */
export function pathRegex() {
  return new RegExp(`${PATH_BODY}(?::~?\\d+)?`, 'g')
}

/** A `path:line` / `path:line-line` citation, capturing path, line and end line. */
export function citeRegex() {
  return new RegExp(`\`?(${PATH_BODY})\`?\\s*:\\s*~?(\\d+)(?:\\s*-\\s*~?(\\d+))?`, 'g')
}
