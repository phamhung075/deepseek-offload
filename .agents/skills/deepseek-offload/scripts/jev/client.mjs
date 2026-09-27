/**
 * Minimal TypeSafe Jev HTTP client for the optional `dsh-offload jev` commands.
 *
 * Zero dependencies: Node >= 18 ships a global `fetch`. The key is read from the
 * environment on every call and is never logged, printed, or persisted; only the
 * endpoint named by `TYPESAFE_API_URL` ever sees it.
 *
 * Every request is one `POST {model, state, questions}`. `noul` questions answer
 * with `{noul}` (probability of yes, 0-1); `choice` questions answer with
 * `{choice, probabilities, confidence}`. `429`/`529`/5xx and a request timeout
 * are retried with exponential backoff; `401` (bad key) and `422` (bad body)
 * fail immediately.
 */

/** Default System One endpoint; `TYPESAFE_API_URL` overrides it (tests use this). */
export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** The model every request asks for. Jev returns the resolved version. */
export const MODEL = 'jev-latest'

/** Retry policy for transient failures. */
export const MAX_TRIES = 5
export const BASE_BACKOFF_MS = 1000
export const MAX_BACKOFF_MS = 16000
export const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529])

/** Abort one HTTP request after this long; a timeout is retried like a network error. */
export const REQUEST_TIMEOUT_MS = 30000

/** In-flight request cap: Jev batches its own work, so a few at a time is enough. */
export const CONCURRENCY = 4

/**
 * The one line every command prints when no key is configured. It is a skip,
 * not an error: Jev is optional and no existing command changes behaviour
 * because of it.
 */
export const DISABLED_LINE = 'jev: disabled — set TYPESAFE_API_KEY'

/** Resolve the API key: `TYPESAFE_API_KEY` first, then the workspace `TYPESAFE_AI_API`. */
export function resolveKey(env = process.env) {
  const key = env.TYPESAFE_API_KEY || env.TYPESAFE_AI_API || ''
  return key === '' ? null : key
}

/** Resolve the endpoint, so a test can point at a local stub. */
export function resolveEndpoint(env = process.env) {
  return env.TYPESAFE_API_URL || DEFAULT_ENDPOINT
}

/** Whether Jev is configured at all. */
export function isEnabled(env = process.env) {
  return resolveKey(env) !== null
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Call System One once, retrying transient failures.
 * @param state - the JSON state the questions read.
 * @param questions - question id -> `{type, instructions, criteria}`.
 * @param env - environment to read the key/endpoint from.
 * @param log - receives retry notes; never receives the key or the body.
 * @param fetchImpl - injectable fetch (defaults to the global).
 * @param requestTimeoutMs - abort one request after this long (a timeout retries).
 * @returns `{json, attempts}`.
 * @throws an Error whose `status` is the last HTTP status when the call fails.
 */
export async function callJev({
  state,
  questions,
  env = process.env,
  log = () => {},
  fetchImpl = globalThis.fetch,
  maxTries = MAX_TRIES,
  baseBackoffMs = BASE_BACKOFF_MS,
  maxBackoffMs = MAX_BACKOFF_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  sleep = defaultSleep,
} = {}) {
  const key = resolveKey(env)
  if (key === null) throw new Error(DISABLED_LINE)
  const endpoint = resolveEndpoint(env)
  const body = JSON.stringify({ model: MODEL, state, questions })
  for (let attempt = 1; ; attempt++) {
    let response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
    } catch (error) {
      // A hung request aborts here (TimeoutError) exactly like a network error.
      if (attempt >= maxTries) throw error
      const wait = Math.min(baseBackoffMs * 2 ** (attempt - 1), maxBackoffMs)
      log(`network error or timeout; retry ${attempt}/${maxTries} in ${wait}ms`)
      await sleep(wait)
      continue
    }
    if (response.ok) return { json: await response.json(), attempts: attempt }
    const text = await response.text()
    if (RETRY_STATUSES.has(response.status) && attempt < maxTries) {
      const wait = Math.min(baseBackoffMs * 2 ** (attempt - 1), maxBackoffMs)
      log(`HTTP ${response.status}; retry ${attempt}/${maxTries} in ${wait}ms`)
      await sleep(wait)
      continue
    }
    const error = new Error(`HTTP ${response.status} ${text.slice(0, 200)}`)
    error.status = response.status
    throw error
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 * @returns results in input order.
 */
export async function pool(items, limit, worker) {
  const out = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      out[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return out
}

/** Render a probability for human output, or `n/a` when Jev returned none. */
export function probability(value) {
  return typeof value === 'number' ? value.toFixed(3) : 'n/a'
}
