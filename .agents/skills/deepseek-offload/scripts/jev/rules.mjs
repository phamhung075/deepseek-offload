/**
 * Code-enforced hard rules for `jev review` and the auto-review.
 *
 * Jev 1.13 can be steered by state content and loses accuracy on irrelevant
 * state, so the rules that must never depend on a model live here, in code:
 * they run BEFORE any Jev call and their findings are reported first. A rule
 * whose severity is `flag` makes the review flagged regardless of Jev.
 *
 * Config: `<projectRoot>/.agents/jev.json`, or the path in
 * `DSH_OFFLOAD_JEV_CONFIG`:
 *
 *   {
 *     "neverTouch": ["secrets/**", "*.pem"],
 *     "pathScope": "off" | "warn" | "flag",   // default "warn"
 *     "ignorePaths": ["generated/**"]
 *   }
 *
 * A missing file means defaults. A malformed file yields one warning line and
 * the defaults for the bad fields; it never throws.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Environment override for the config path. */
export const CONFIG_ENV = 'DSH_OFFLOAD_JEV_CONFIG'

/** The config's default path, relative to the project root. */
export const CONFIG_RELATIVE = path.join('.agents', 'jev.json')

/** `pathScope` values, weakest first. */
export const PATH_SCOPE_MODES = ['off', 'warn', 'flag']

/** Default config; a missing file uses this object verbatim. */
export const DEFAULT_CONFIG = Object.freeze({ neverTouch: [], pathScope: 'warn', ignorePaths: [] })

/** Rule ids and the human strings the report shows for them. */
export const RULE_NEVER_TOUCH = 'never-touch'
export const RULE_PATH_SCOPE = 'path-scope'
export const MESSAGE_NEVER_TOUCH = 'never-touch path'
export const MESSAGE_PATH_SCOPE = 'outside paths named in the work order'

/** Severities a finding can carry. */
export const SEVERITY_FLAG = 'flag'
export const SEVERITY_WARN = 'warn'

const GLOB_SPECIALS = new Set(['\\', '^', '$', '.', '|', '+', '(', ')', '[', ']', '{', '}'])

/** Most alternatives `expandBraces` will emit for one token before giving up. */
export const BRACE_EXPANSION_MAX = 64

// A path-ish run that contains at least one brace group, e.g. `a/{x,y}/b.mjs`
// or `a/{x,y}/{p,q}.mjs`. Only brace groups with a comma and no whitespace are
// expanded; anything else is left to the normal tokeniser.
const BRACE_TOKEN_RE = /[A-Za-z0-9_@./~:+-]*(?:\{[^{}\s]*\}[A-Za-z0-9_@./~:+-]*)+/g

/**
 * Translate a small glob (`**`, `*`, `?`) into an anchored regular expression.
 * `*`/`?` never cross `/`; `**` crosses anything, and a `**` followed by a
 * slash may match zero directories.
 */
export function globToRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index++
        if (pattern[index + 1] === '/') {
          index++
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if (GLOB_SPECIALS.has(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  return new RegExp(`^${source}$`)
}

const globCache = new Map()

function compiledGlob(pattern) {
  let regexp = globCache.get(pattern)
  if (regexp === undefined) {
    regexp = globToRegExp(pattern)
    globCache.set(pattern, regexp)
  }
  return regexp
}

/**
 * Whether a repo-relative path matches a glob. A pattern without `/` is tested
 * against the basename too, so `*.pem` matches `a/b/key.pem`.
 */
export function globMatch(pattern, file) {
  const normalized = String(file ?? '').replace(/\\/g, '/')
  const regexp = compiledGlob(pattern)
  if (regexp.test(normalized)) return true
  if (!pattern.includes('/')) return regexp.test(normalized.split('/').pop() ?? '')
  return false
}

const firstLine = (text) => String(text ?? '').split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''

/** Resolve the config path for a project root (the env override wins). */
export function configPath(projectRoot, env = process.env) {
  const override = env[CONFIG_ENV]
  if (typeof override === 'string' && override !== '') return override
  return path.join(typeof projectRoot === 'string' && projectRoot !== '' ? projectRoot : process.cwd(), CONFIG_RELATIVE)
}

/**
 * Load and validate the rules config.
 * @returns `{config, warning, path}`; `warning` is one line or null.
 */
export function loadRulesConfig({ projectRoot, env = process.env } = {}) {
  const file = configPath(projectRoot, env)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { config: { ...DEFAULT_CONFIG }, warning: null, path: file }
    return { config: { ...DEFAULT_CONFIG }, warning: `cannot read ${file} (${firstLine(error.message)}); using defaults`, path: file }
  }

  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { config: { ...DEFAULT_CONFIG }, warning: `${file} is not valid JSON (${firstLine(error.message)}); using defaults`, path: file }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: { ...DEFAULT_CONFIG }, warning: `${file} must be a JSON object; using defaults`, path: file }
  }

  const issues = []
  const config = { ...DEFAULT_CONFIG }
  if (raw.neverTouch !== undefined) {
    if (Array.isArray(raw.neverTouch) && raw.neverTouch.every((entry) => typeof entry === 'string')) {
      config.neverTouch = raw.neverTouch
    } else {
      issues.push('neverTouch must be an array of glob strings')
    }
  }
  if (raw.pathScope !== undefined) {
    if (PATH_SCOPE_MODES.includes(raw.pathScope)) config.pathScope = raw.pathScope
    else issues.push('pathScope must be one of off|warn|flag')
  }
  if (raw.ignorePaths !== undefined) {
    if (Array.isArray(raw.ignorePaths) && raw.ignorePaths.every((entry) => typeof entry === 'string')) {
      config.ignorePaths = raw.ignorePaths
    } else {
      issues.push('ignorePaths must be an array of glob strings')
    }
  }
  const warning = issues.length === 0 ? null : `${file}: ${issues.join('; ')}; using defaults for those fields`
  return { config, warning, path: file }
}

/**
 * Drop hunks whose file matches an `ignorePaths` glob before any rule or Jev
 * sees them.
 * @returns `{groups, ignored}`; groups with no hunks left are removed.
 */
export function applyIgnorePaths(groups, ignorePaths) {
  if (!Array.isArray(ignorePaths) || ignorePaths.length === 0) return { groups, ignored: [] }
  const ignored = []
  const kept = []
  for (const group of groups) {
    const hunks = []
    for (const hunk of group.hunks) {
      if (ignorePaths.some((pattern) => globMatch(pattern, hunk.file))) {
        ignored.push({ sha: group.sha, file: hunk.file, range: hunk.range })
      } else {
        hunks.push(hunk)
      }
    }
    if (hunks.length > 0) kept.push({ ...group, hunks })
  }
  return { groups: kept, ignored }
}

// A path token in the work order: word-ish characters plus the separators a
// repo path uses, with an optional leading `/` for an absolute path. A token
// may also start with `./` (normalised away later) or with a single `.` followed
// by a name character, so dot-directories and dotfiles (`.agents/`, `.github/`,
// `.env`) are captured. The lookbehind stops a match from beginning inside a
// `..`-relative segment (`../foo`) or another token, so bare `.`/`..`/`...` are
// never matched. Backticks and trailing punctuation are not part of the token.
const NAMED_TOKEN_RE = /(?<![A-Za-z0-9_@./~:+-])(?:\/?(?:\.\/)?[A-Za-z0-9_@][A-Za-z0-9_@./~:+-]*|\/?\.[A-Za-z0-9_@][A-Za-z0-9_@./~:+-]*)/g
const CITATION_SUFFIX_RE = /:~?\d+(?:-~?\d+)?$/
const TRAILING_PUNCTUATION_RE = /[.,;:)\]}>'"]+$/
const FILE_EXTENSION_RE = /\.[A-Za-z0-9]{1,10}$/

function stripDecoration(token) {
  let value = token.replace(TRAILING_PUNCTUATION_RE, '')
  value = value.replace(CITATION_SUFFIX_RE, '')
  value = value.replace(/[.,;:)\]}>'"]+$/, '')
  return value
}

/**
 * Split a token into literal strings and the brace-group option lists it holds.
 * A group counts only when it contains a comma and no whitespace or nested
 * braces; every other `{...}` stays literal.
 */
function braceSegments(token) {
  const segments = []
  let literal = ''
  for (let index = 0; index < token.length; index++) {
    if (token[index] !== '{') {
      literal += token[index]
      continue
    }
    const close = token.indexOf('}', index + 1)
    const inner = close === -1 ? null : token.slice(index + 1, close)
    if (inner === null || !inner.includes(',') || /[\s{}]/.test(inner)) {
      literal += token[index]
      continue
    }
    if (literal !== '') {
      segments.push(literal)
      literal = ''
    }
    segments.push(inner.split(','))
    index = close
  }
  if (literal !== '') segments.push(literal)
  return segments
}

/**
 * Expand the brace groups of one path-like token into its cartesian product:
 * `a/{x,y}.mjs` becomes `['a/x.mjs', 'a/y.mjs']` and several groups multiply.
 * A group without a comma or with spaces inside, and any expansion larger than
 * `BRACE_EXPANSION_MAX`, leaves the token unchanged as a single result.
 */
export function expandBraces(token) {
  const text = String(token ?? '')
  let results = ['']
  for (const segment of braceSegments(text)) {
    const options = Array.isArray(segment) ? segment : [segment]
    const next = []
    for (const prefix of results) {
      for (const option of options) next.push(prefix + option)
    }
    if (next.length > BRACE_EXPANSION_MAX) return [text]
    results = next
  }
  return results
}

/** Replace every expandable brace token in `text` with its options, space-separated. */
function expandBraceTokens(text) {
  return text.replace(BRACE_TOKEN_RE, (token) => expandBraces(token).join(' '))
}

/**
 * Extract the repo-relative paths/directories a work order names. Brace groups
 * in path-like tokens are expanded first (`a/{x,y}.mjs` names both files). A
 * token qualifies when it contains `/` or a file extension; absolute paths
 * inside the review repo are made relative, and everything else is dropped.
 * @returns `{value, raw}[]`, deduped in first-seen order.
 */
export function extractNamedPaths(workOrder, repo) {
  const out = []
  const seen = new Set()
  const absoluteRepo = typeof repo === 'string' && repo !== '' ? path.resolve(repo) : null
  for (const match of expandBraceTokens(String(workOrder ?? '')).matchAll(NAMED_TOKEN_RE)) {
    const raw = match[0]
    if (raw.includes('://')) continue
    let value = stripDecoration(raw)
    if (value === '' || value === '.' || value === '..') continue
    const isAbsolute = value.startsWith('/')
    if (isAbsolute) {
      if (absoluteRepo === null) continue
      const relative = path.relative(absoluteRepo, value)
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue
      value = relative
    }
    value = value.replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (value === '') continue
    const qualifies = value.includes('/') || FILE_EXTENSION_RE.test(value)
    if (!qualifies) continue
    if (seen.has(value)) continue
    seen.add(value)
    out.push({ value, raw })
  }
  return out
}

/**
 * The directory a named path sits in, when that named path is a FILE rather
 * than a directory: only a path with a `/` whose basename carries a file
 * extension qualifies (`server-go/internal/mcp/mcp.go`, not `server-go/internal/mcp`).
 * @returns the directory string, or null when the name is a directory.
 */
function namedFileDir(value) {
  const slash = value.lastIndexOf('/')
  if (slash <= 0) return null
  const base = value.slice(slash + 1)
  return FILE_EXTENSION_RE.test(base) ? value.slice(0, slash) : null
}

/** Whether two directory strings are the same directory, on a `/` boundary. */
function isSameDir(fileDir, namedDir) {
  return fileDir === namedDir || fileDir.endsWith(`/${namedDir}`)
}

/**
 * Whether a hunk file is covered by a named path. A name with `/` matches as a
 * segment-aligned prefix or suffix at any depth (`scripts/jev/route.mjs` covers
 * `.agents/.../scripts/jev/route.mjs`); a bare file name without `/` matches a
 * hunk whose basename equals it at any depth. A hunk in the same directory as a
 * named FILE (a name with `/` whose basename has an extension) is also in
 * scope: an order naming `server-go/internal/mcp/mcp.go` covers a new
 * `server-go/internal/mcp/batch.go`. Directory names and globs are untouched,
 * and a hunk in a different directory still warns.
 */
export function isUnderNamedPath(file, named) {
  const target = String(file ?? '')
  const base = target.split('/').pop() ?? ''
  const fileDir = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : ''
  for (const { value } of named) {
    if (value.includes('/')) {
      if (target === value || target.startsWith(`${value}/`) || target.endsWith(`/${value}`) || target.includes(`/${value}/`)) return true
      const dir = namedFileDir(value)
      if (dir !== null && fileDir !== '' && isSameDir(fileDir, dir)) return true
    } else if (base === value) {
      return true
    }
  }
  return false
}

/** Test siblings are allowed wherever they sit: `*_test.go`, `*.test.*`, `tests/`. */
export function isTestSibling(file) {
  const base = file.split('/').pop() ?? ''
  return /_test\.go$/.test(base)
    || /\.test\./.test(base)
    || file.startsWith('tests/')
    || file.includes('/tests/')
}

/**
 * Evaluate the hard rules over the (already ignore-filtered) groups.
 * @returns `{findings, pathScope, flagHits}`.
 */
export function evaluateRules({ groups, workOrder, config, repo }) {
  const findings = []
  for (const group of groups) {
    for (const hunk of group.hunks) {
      for (const pattern of config.neverTouch) {
        if (!globMatch(pattern, hunk.file)) continue
        findings.push({
          rule: RULE_NEVER_TOUCH,
          message: MESSAGE_NEVER_TOUCH,
          severity: SEVERITY_FLAG,
          sha: group.sha,
          file: hunk.file,
          range: hunk.range,
          detail: `matches neverTouch glob ${pattern}`,
        })
        break
      }
    }
  }

  const pathScope = { mode: config.pathScope, skipped: false, named: [], reason: null }
  if (config.pathScope !== 'off') {
    const named = extractNamedPaths(workOrder, repo)
    pathScope.named = named.map((entry) => entry.value)
    if (named.length === 0) {
      pathScope.skipped = true
      pathScope.reason = 'the work order names no paths'
    } else {
      for (const group of groups) {
        for (const hunk of group.hunks) {
          if (isUnderNamedPath(hunk.file, named) || isTestSibling(hunk.file)) continue
          findings.push({
            rule: RULE_PATH_SCOPE,
            message: MESSAGE_PATH_SCOPE,
            severity: config.pathScope === 'flag' ? SEVERITY_FLAG : SEVERITY_WARN,
            sha: group.sha,
            file: hunk.file,
            range: hunk.range,
            detail: 'not under any path the work order names',
          })
        }
      }
    }
  }

  const flagHits = findings.filter((finding) => finding.severity === SEVERITY_FLAG).length
  return { findings, pathScope, flagHits }
}

/** The `rules` section of a review report (rule findings first). */
export function rulesReport({ configPath: file, warning, findings, pathScope, ignored }) {
  return {
    configPath: file,
    configWarning: warning,
    pathScope,
    ignored: ignored ?? [],
    findings,
  }
}
