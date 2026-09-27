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
// repo path uses, with an optional leading `/` for an absolute path. Backticks
// and trailing punctuation are not part of the token.
const NAMED_TOKEN_RE = /\/?[A-Za-z0-9_@][A-Za-z0-9_@./~:+-]*/g
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
 * Extract the repo-relative paths/directories a work order names. A token
 * qualifies when it contains `/` or a file extension; absolute paths inside the
 * review repo are made relative, and everything else is dropped.
 * @returns `{value, raw}[]`, deduped in first-seen order.
 */
export function extractNamedPaths(workOrder, repo) {
  const out = []
  const seen = new Set()
  const absoluteRepo = typeof repo === 'string' && repo !== '' ? path.resolve(repo) : null
  for (const match of String(workOrder ?? '').matchAll(NAMED_TOKEN_RE)) {
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

function isUnderNamedPath(file, named) {
  for (const { value } of named) {
    if (file === value || file.startsWith(`${value}/`)) return true
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
