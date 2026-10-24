/**
 * Host half of dsh-llm-llamacpp: declares OpenAI-compatible llama.cpp routes,
 * streams chat completions, and serves the client's live metrics snapshot.
 * Upstream traffic is client-driven; the host has no timers.
 */
import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'

// The test suite imports a generated copy from test/, so accept the package
// manifest from either the plugin root or its parent. The real plugin always
// resolves the first path.
const loadJson = createRequire(import.meta.url)
const PLUGIN_VERSION = (() => {
  for (const path of ['./package.json', '../package.json']) {
    try {
      const version = loadJson(path)?.version
      if (typeof version === 'string' && version !== '') return version
    } catch { /* try the next location */ }
  }
  return 'unknown'
})()
const USER_AGENT = `dsh-llm-llamacpp ${PLUGIN_VERSION}`

/**
 * The llama.cpp servers this plugin serves, by provider route.
 *
 * Each entry is declared in the plugin row's `servers` map. Settings → Models
 * edits the map through this plugin's provider card, and a committed write
 * re-resolves this map without re-applying the plugin.
 *
 * @type {Map<string, { provider: string, alias: string, baseURL: string, origin: string, apiKeyEnv: string|null }>}
 */
let servers = new Map()
/** route -> validation message, for declared routes that could not be served. */
let routeErrors = new Map()
/** every declared route, including the unserviceable ones, for the Models directory. */
let declaredRoutes = []
/** origin -> { state, metricsEnabled, props, at } */
const verdicts = new Map()
/** origin -> [{ t, predicted, predictedSeconds, prompt, promptSeconds }] newest last */
const samples = new Map()
/** origin -> when its last live readings request succeeded */
const lastLiveAt = new Map()
/** origin -> Promise */
const inflight = new Map()

const PROBE_TIMEOUT_MS = 1500
const LIVE_TIMEOUT_MS = 2000
const SAMPLE_WINDOW_MS = 60_000
const SAMPLE_MAX = 30
const SAMPLE_MIN_SPAN_MS = 4000

const METRIC_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(\{[^\n]*\})?\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/

const hasFetch = typeof globalThis.fetch === 'function'

/** Whether a Prometheus body looks like llama.cpp output (`llamacpp:` or `llama_cpp_` families). */
function isLlamaMetrics(text) {
  return typeof text === 'string' && /(^|\n)[a-z]*llama[._-]?cpp[:_-]/.test(text)
}

/** The `http(s)` origin of a configured endpoint, or undefined. */
function originOf(baseURL) {
  if (typeof baseURL !== 'string') return undefined
  try {
    const url = new URL(baseURL)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

/** A provider route id: lowercase, hyphen-separated, usable as a settings key. */
const ROUTE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
/** A DSH credential reference: a POSIX shell identifier. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Validate the full API base URL requests are built from.
 *
 * The path is required: llama-server's OpenAI-compatible base is
 * `http://host:9931/v1`, and silently appending `/v1` to an address without a
 * path hid a broken endpoint. A proxy prefix is accepted as written; only
 * trailing slashes are trimmed.
 *
 * @param value - raw endpoint.
 * @returns the full http(s) URL, or null when invalid.
 */
function parseBaseURL(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.search !== '' || url.hash !== '') return null
  const path = url.pathname.replace(/\/+$/, '')
  if (path === '') return null
  url.pathname = path
  return url.toString().replace(/\/+$/, '')
}

/** A user alias that still carries the display wrapper is stored without it. */
const ALIAS_WRAPPER = /^llama\.cpp\s*\((.*)\)$/i

/**
 * The bare alias stored for a route: host:port by default, or whatever the user
 * typed. The `llama.cpp (...)` wrapper is presentation, never part of the alias.
 *
 * @param value - a raw alias, possibly carrying the display wrapper.
 * @returns the trimmed bare alias, or ''.
 */
function bareAlias(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '') return ''
  const match = ALIAS_WRAPPER.exec(text)
  return (match === null ? text : match[1].trim())
}

/** The name the Models row and model picker show for a bare alias. */
function displayNameFor(alias) {
  return `llama.cpp (${alias})`
}

/**
 * The bare alias a route uses when its profile names none.
 *
 * Both the model picker and the Models row identify a route by this name, and
 * plain "llama.cpp" cannot tell two servers apart. The endpoint's host is the
 * one fact that always differs; the `llama.cpp (...)` wrapper is added at
 * display time, not stored.
 *
 * @param origin - the route's origin (`http://host:port`).
 * @param provider - the route id, used when the origin carries no host.
 * @returns the bare `host:port` or route id.
 */
function defaultAlias(origin, provider) {
  try {
    const host = new URL(origin).host
    return host === '' ? provider : host
  } catch {
    return provider
  }
}

/**
 * Resolve one route's credential for the CURRENT operation.
 *
 * The credential store is authoritative; the launch environment is the ambient
 * fallback. A reference that is set but resolves to nothing is an error, not a
 * silent unauthenticated request: llama-server may answer 401 later, but the
 * failure should name the missing reference.
 *
 * @param ctx - host context; services are read opportunistically.
 * @param entry - resolved route carrying `apiKeyEnv`.
 * @returns the secret, or null when the route declares no credential.
 */
async function credentialValue(ctx, entry) {
  const ref = typeof entry?.apiKeyEnv === 'string' && entry.apiKeyEnv !== '' ? entry.apiKeyEnv : null
  if (ref === null) return null
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value !== '') return hit.value
    } catch { /* fall through to the ambient layers */ }
  }
  const launch = ctx?.launchEnvironment
  const ambient = typeof launch?.get === 'function' ? launch.get(ref)?.value : undefined
  const value = typeof ambient === 'string' && ambient !== '' ? ambient : process.env[ref]
  if (typeof value === 'string' && value !== '') return value
  throw adapterFailure(`no credential for llama.cpp route "${entry.provider}"; ${ref} is not set`, 'MISSING_CREDENTIAL')
}

/**
 * Authorization headers for one route, resolved per operation.
 *
 * @param ctx - host context.
 * @param entry - resolved route.
 * @returns `{}` for a keyless route, else `{ authorization }`.
 */
async function routeHeaders(ctx, entry) {
  const key = await credentialValue(ctx, entry)
  return key === null ? {} : { authorization: `Bearer ${key}` }
}

/** GET text with a hard timeout; null on any failure. */
async function fetchText(url, timeoutMs, auth = {}) {
  if (!hasFetch) return null
  try {
    const res = await globalThis.fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/plain, application/json;q=0.9', ...auth },
    })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

/** GET JSON with a hard timeout; null on any failure or non-JSON body. */
async function fetchJson(url, timeoutMs, auth = {}) {
  if (!hasFetch) return null
  try {
    const res = await globalThis.fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', ...auth },
    })
    return res.ok ? await res.json().catch(() => null) : null
  } catch {
    return null
  }
}

/**
 * Current prefill speed of one request, in tokens per second.
 *
 * The last batch the server reported: `Δ(processed - cache)` over `Δtime_ms`. Two
 * things are load-bearing and were learned the hard way:
 *
 * - it is a DELTA of `processed - cache`, never of `processed`: the latter includes
 *   the reused prefix, so a mostly-cached prompt's first frame pair reads tens of
 *   millions of tok/s;
 * - `Δtime_ms` must span at least {@link RATE_MIN_SPAN_MS}. The server emits frames
 *   back to back at a batch boundary, so the same 2045-token batch reads as 347
 *   tok/s over 5.9 s, 3466 over 590 ms or 34000 over 60 ms.
 *
 * Frames arrive once per batch (every ~6 s here), so a time window would usually
 * hold a single sample; the last pair is the current speed at the only resolution
 * the server offers.
 *
 * @param samples - the request's ring (mutated).
 * @param fresh - processed minus cached tokens.
 * @param timeMs - the server's elapsed prompt time.
 * @returns tokens/s, or undefined when this pair cannot support a rate.
 */
function promptWindowRate(samples, fresh, timeMs) {
  samples.push({ fresh, timeMs })
  if (samples.length > 3) samples.shift()
  const previous = samples[samples.length - 2]
  if (previous === undefined) return undefined
  const span = timeMs - previous.timeMs
  const gain = fresh - previous.fresh
  if (span < RATE_MIN_SPAN_MS || gain <= 0) return undefined
  return gain / (span / 1000)
}

/**
 * Current generation speed of one request, in tokens per second: tokens produced
 * over the last {@link RATE_WINDOW_MS} of its own generation clock.
 *
 * `timings` arrives per token (with `timings_per_token`), so a single pair is too
 * jittery to read; the window smooths that without the minutes of lag the server's
 * `predicted_per_second` carries — that one is cumulative, so when another slot
 * starts competing for the machine it barely moves, which is the change a reader is
 * looking for. The most recent pair is always kept, so a stall shows up as the low
 * rate it is instead of being trimmed away.
 *
 * @param samples - the request's ring (mutated).
 * @param n - `timings.predicted_n`.
 * @param ms - `timings.predicted_ms`.
 * @returns tokens/s, or undefined when the window cannot support one yet.
 */
function decodeWindowRate(samples, n, ms) {
  samples.push({ n, ms })
  while (samples.length > 2 && ms - samples[0].ms > RATE_WINDOW_MS) samples.shift()
  while (samples.length > RATE_SAMPLES_MAX) samples.shift()
  const first = samples[0]
  const span = ms - first.ms
  const gain = n - first.n
  if (span < RATE_MIN_SPAN_MS || gain <= 0) return undefined
  return gain / (span / 1000)
}

/**
 * Discriminate one endpoint origin: `llama` (with metrics posture),
 * `not-llama`, or `unreachable`. One probe, called only per the plan's
 * initialization / model-change / reload triggers.
 */
async function probeOrigin(origin, auth = {}) {
  let props = null
  let status = 0
  try {
    const res = await globalThis.fetch(`${origin}/props`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: 'application/json', ...auth },
    })
    status = res.status
    if (res.ok) props = await res.json().catch(() => null)
  } catch {
    return { state: 'unreachable', metricsEnabled: false, props: null }
  }
  if (status === 401 || status === 403) return { state: 'unauthorized', metricsEnabled: false, props: null }

  const isLlama = props !== null && typeof props === 'object' && (
    typeof props.total_slots === 'number'
    || typeof props.build_info === 'string'
    || (typeof props.model === 'object' && props.model !== null)
  )
  const metrics = await fetchText(`${origin}/metrics`, PROBE_TIMEOUT_MS, auth)
  const metricsEnabled = isLlamaMetrics(metrics)
  if (isLlama || metricsEnabled) {
    const normalized = normalizeProps(props)
    if (typeof normalized?.nCtx === 'number' && normalized.nCtx > 0) probedContextWindows.set(origin, normalized.nCtx)
    return { state: 'llama', metricsEnabled, props: normalized }
  }
  return { state: 'not-llama', metricsEnabled: false, props: null }
}

/** Cap for raw samples forwarded to the client dialog. */
const RAW_METRIC_MAX = 240

/**
 * Parse one Prometheus body in a single pass: per-name sums across label sets
 * (the numbers the derived readings use) and the capped raw sample list the
 * dialog renders in source order.
 *
 * @param text - the `/metrics` body.
 * @returns `{ sums: Map<name, number>, raw: { name, labels, value }[] }`.
 */
function parseMetrics(text) {
  const sums = new Map()
  const raw = []
  // `sums` folds labeled series together, so it cannot count the samples the
  // dialog was offered; that number has to be counted here.
  let rawTotal = 0
  for (const line of String(text).split('\n')) {
    const match = METRIC_LINE.exec(line)
    if (match === null) continue
    const value = Number.parseFloat(match[3])
    if (!Number.isFinite(value)) continue
    rawTotal += 1
    sums.set(match[1], (sums.get(match[1]) ?? 0) + value)
    if (raw.length < RAW_METRIC_MAX) {
      raw.push({ name: match[1], labels: typeof match[2] === 'string' ? match[2].slice(1, -1) : null, value })
    }
  }
  return { sums, raw, rawTotal }
}

/** First present counter value among candidate names across llama.cpp versions. */
function pick(metrics, ...names) {
  for (const name of names) {
    const value = metrics.get(name)
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Everything the dialog's "All metrics" section shows, derived from one
 * `/metrics` scrape.
 *
 * **Units are the trap.** `predicted_tokens_seconds` looks like the generation
 * rate, but it counts generation STEPS, not tokens (`server-common.h`:
 * `bucket.n_per_second() = steps / time`, "the rate uses the decode steps, so
 * that free tokens do not inflate it"), so a slot producing one token per step
 * reads about `1 / n_busy_slots_per_decode` of the server's real throughput. It
 * therefore cannot stand in for a token rate: `decodeTps` falls back to the
 * counters' own ratio and the gauge stays in `raw[]`.
 *
 * @param origin - endpoint key of the rate sample window.
 * @param sums - summed counter/gauge values, or null when `/metrics` is off.
 * @param raw - samples forwarded to the dialog (capped at {@link RAW_METRIC_MAX}).
 * @param rawTotal - samples parsed, before the cap.
 * @param now - the moment the scrape was read.
 * @returns the metrics payload object, or null when there were no readings.
 */
function deriveMetrics(origin, sums, raw, rawTotal, now) {
  if (sums === null) return null
  const predicted = pick(sums, 'llamacpp:tokens_predicted_total', 'llama_cpp_decode_tokens_total', 'llama_cpp_generate_tokens_predicted_total', 'llama_cpp_generate_tokens_total')
  const predictedSeconds = pick(sums, 'llamacpp:tokens_predicted_seconds_total', 'llama_cpp_decode_seconds_total', 'llama_cpp_generate_seconds_decode_seconds_total', 'llama_cpp_generate_seconds_total')
  const prompt = pick(sums, 'llamacpp:prompt_tokens_total', 'llama_cpp_prompt_tokens_total')
  const promptSeconds = pick(sums, 'llamacpp:prompt_seconds_total', 'llama_cpp_prompt_seconds_total')
  const cachedPrompt = pick(sums, 'llamacpp:prompt_tokens_cached_total', 'llama_cpp_prompt_tokens_saved_total', 'llama_cpp_generate_tokens_cached_total')

  if (predicted !== undefined && predictedSeconds !== undefined) {
    const window = (samples.get(origin) ?? []).filter(s => now - s.t <= SAMPLE_WINDOW_MS)
    const last = window[window.length - 1]
    if (last === undefined || last.predicted !== predicted || last.predictedSeconds !== predictedSeconds) {
      window.push({ t: now, predicted, predictedSeconds, prompt, promptSeconds })
      while (window.length > SAMPLE_MAX) window.shift()
      samples.set(origin, window)
    }
  }

  const promptGauge = pick(sums, 'llamacpp:prompt_tokens_seconds')
  const specDraft = pick(sums, 'llamacpp:spec_decode_num_draft_tokens_total')
  const specAccepted = pick(sums, 'llamacpp:spec_decode_num_accepted_tokens_total')
  const specSteps = pick(sums, 'llamacpp:spec_decode_num_drafts_total')
  const promptTotal = (prompt ?? 0) + (cachedPrompt ?? 0)
  // Tokens per second OF DECODING, the only unit `decodeTps` may answer in.
  const decodedOverall = predicted !== undefined && predictedSeconds !== undefined && predictedSeconds > 0
    ? Math.round((predicted / predictedSeconds) * 10) / 10
    : null

  return {
    decodeTps: instantRate(origin, 'predicted', 'predictedSeconds', decodedOverall, now),
    promptTps: instantRate(origin, 'prompt', 'promptSeconds', promptGauge ?? null, now),
    cacheHitPercent: promptTotal > 0 && cachedPrompt !== undefined ? Math.round((cachedPrompt / promptTotal) * 1000) / 10 : null,
    predictedTotal: predicted ?? null,
    promptTotal: prompt ?? null,
    cachedPromptTotal: cachedPrompt ?? null,
    promptSecondsTotal: promptSeconds ?? null,
    decodeSecondsTotal: predictedSeconds ?? null,
    requestsProcessing: pick(sums, 'llamacpp:requests_processing') ?? null,
    requestsDeferred: pick(sums, 'llamacpp:requests_deferred') ?? null,
    specAcceptPercent: specDraft !== undefined && specAccepted !== undefined && specDraft > 0 ? Math.round((specAccepted / specDraft) * 1000) / 10 : null,
    specAcceptedTokens: specAccepted ?? null,
    specDraftSteps: specSteps ?? null,
    nBusySlotsPerDecode: pick(sums, 'llamacpp:n_busy_slots_per_decode') ?? null,
    nTokensMax: pick(sums, 'llamacpp:n_tokens_max') ?? null,
    rawTotal,
    raw,
  }
}

/**
 * Summarize `/slots` (array or object, `--slots` builds only) for the dialog:
 * the retained-context totals plus one row per slot.
 *
 * **Why the retained context:** `n_prompt_tokens` is the slot's current context
 * length (its KV sequence: cached prefix, freshly processed tokens and generated
 * tokens), which tells a reader whether a slot will serve the next request
 * cheaply. `n_prompt_tokens_cache` is zeroed when the next task launches, so it
 * cannot serve as that total.
 *
 * **Why this is not the pill's source:** `n_prompt_tokens` is not the task's
 * prompt total, so a completion percentage has no denominator here — a slot's
 * prompt progress is derived from the request's own SSE stream instead (see
 * `llamaStream`), and only for requests this process owns.
 *
 * @param body - the `/slots` response body.
 * @returns `{ total, processing, ctxTokens, ctxMax, ctxPercent, rows }`, or null.
 */
function normalizeSlots(body) {
  const slots = Array.isArray(body) ? body : body !== null && typeof body === 'object' ? [body] : []
  const rows = []
  let total = 0, processing = 0, ctxTokens = 0, ctxMax = 0
  for (const slot of slots) {
    if (typeof slot !== 'object' || slot === null) continue
    total += 1
    // Builds before the `i`-flattening / `n_cache` renames kept the counters
    // nested; both shapes are still read.
    const info = typeof slot.i === 'object' && slot.i !== null ? slot.i : slot
    const nCtx = firstPositive(slot.n_ctx, info.n_ctx)
    if (nCtx !== null) ctxMax += nCtx
    // Absent until the slot has taken a task at all, then the retained context
    // of its current or last task.
    const ctxLen = numberOrNull(info.n_prompt_tokens)
    if (ctxLen !== null) ctxTokens += ctxLen
    const active = slot.is_processing === true
    if (active) processing += 1
    const decoded = numberOrNull(nextTokenOf(slot)?.n_decoded)
    rows.push({
      id: numberOrNull(slot.id),
      active,
      // No percentage is drawn from `/slots`, so the phase only picks the
      // wording: a slot that has generated tokens is decoding, any other active
      // slot is still working through its prompt.
      phase: !active ? 'idle' : decoded !== null && decoded > 0 ? 'decode' : 'prompt',
      nCtx,
      ctxLen,
      processed: numberOrNull(info.n_prompt_tokens_processed),
      cache: firstNumberOrNull(info.n_prompt_tokens_cache, info.n_cache),
      decoded,
      speculative: slot.speculative === true,
    })
  }
  if (total === 0) return null
  return {
    total,
    processing,
    ctxTokens,
    ctxMax,
    ctxPercent: ctxMax > 0 ? Math.round((ctxTokens / ctxMax) * 1000) / 10 : null,
    rows,
  }
}

/** A finite number from the server, or null when the field is absent. */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The first present finite number, or null — for renamed fields across builds. */
function firstNumberOrNull(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/** The first strictly positive number, or null — capacities are never 0. */
function firstPositive(...values) {
  for (const value of values) {
    if (typeof value === 'number' && value > 0) return value
  }
  return null
}

/**
 * Per-slot rate memory: origin -> Map<slotId, sample>. `/props` exposes no
 * `n_batch`, and the SSE owns the exact per-token timings for our own requests,
 * so this is the rate of last resort for a slot this process does not own.
 */
const slotSamples = new Map()
const RATE_MIN_SPAN_S = 0.4
/** How much of a body the error paths quote back to the user. */
const SNIPPET_MAX = 200
/** How often an unnamed in-flight request re-reads its session identity. */
const LABEL_RETRY_MS = 1000
/**
 * How long a finished request stays in the payload.
 *
 * A task that takes several turns — every sub-agent does — has no request in
 * flight while it runs a tool, so deleting the entry the instant the stream ends
 * made its row blink out of the dialog and come back as a different row in a
 * different place. Five seconds covers the tool calls that matter (reads,
 * searches) without letting dead rows pile up.
 */
const HOLD_MS = 5000
/** How long a session's first-seen time is remembered after its last request. */
const TASK_KEEP_MS = 600_000
/**
 * Current-speed windows. A reader watches for exactly one thing while a request
 * runs: whether it is going faster or slower NOW — which, with several slots
 * sharing the machine, changes by factors, not percentages. So the rates are
 * measured over a short recent window instead of averaged over the request:
 * 1.5 s of generation, and (for a prompt) the last batch the server reported,
 * which is already the finest granularity it offers (~6 s here).
 */
const RATE_WINDOW_MS = 1500
/** Below this span the divisor is noise: two frames 1 ms apart are not a rate. */
const RATE_MIN_SPAN_MS = 400
/** Samples carried per window; a rate above ~85 tok/s hits this before the window. */
const RATE_SAMPLES_MAX = 128
/** A rate older than this is no longer an estimate of anything: drop it. */
const RATE_TTL_MS = 10_000

/**
 * Stamp every row with the rate observed since the previous poll of that slot.
 *
 * Both counters are per-task and start at zero, so a decrease means a new task
 * took the slot, and a sample taken while the slot was idle says nothing about
 * the current one. Only the phase that is actually advancing gets a rate.
 *
 * @param origin - llama.cpp endpoint origin.
 * @param rows - `normalizeSlots` rows; mutated with `decodeTps`.
 * @param now - the moment the `/slots` body was read.
 */
function rateSlots(origin, rows, now) {
  let perSlot = slotSamples.get(origin)
  if (perSlot === undefined) {
    perSlot = new Map()
    slotSamples.set(origin, perSlot)
  }
  for (const row of rows) {
    const key = row.id ?? 'slot'
    const previous = perSlot.get(key)
    const newTask = previous === undefined || previous.active !== true
      || (row.processed !== null && previous.processed !== null && row.processed < previous.processed)
      || (row.decoded !== null && previous.decoded !== null && row.decoded < previous.decoded)
    // A slot that has produced nothing since an old sample must not keep showing
    // that number as if it were live.
    const stale = previous !== undefined && now - previous.t > RATE_TTL_MS
    let decodeTps = newTask || stale ? null : previous.decodeTps
    if (previous !== undefined && !newTask && !stale) {
      const seconds = (now - previous.t) / 1000
      if (seconds >= RATE_MIN_SPAN_S && row.phase === 'decode'
        && row.decoded !== null && previous.decoded !== null && row.decoded > previous.decoded) {
        decodeTps = roundedRate((row.decoded - previous.decoded) / seconds)
      }
    }
    // Only decoding has a rate this way: `ctxLen` (a slot's context length) barely
    // moves while its prompt is being processed — measured 7 tok/s during a prefill
    // the stream reported at 350 — so a "prompt rate" from it would be a lie of an
    // entirely different kind. A prompt row's rate comes from its own stream
    // (`promptTps`), and a row with no stream shows none.
    row.promptTps = null
    row.decodeTps = row.phase === 'decode' ? decodeTps : null
    perSlot.set(key, {
      t: now,
      active: row.active,
      ctxLen: row.ctxLen,
      processed: row.processed,
      decoded: row.decoded,
      decodeTps: row.decodeTps,
    })
  }
  // A changed `n_parallel` leaves samples for slots the server no longer reports.
  for (const key of [...perSlot.keys()]) {
    if (!rows.some(row => (row.id ?? 'slot') === key)) perSlot.delete(key)
  }
}

/** One decimal below 10, whole numbers above: `0.4` and `47`. */
function roundedRate(tps) {
  return tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10
}

/** `next_token` is an array holding one object on this build. */
function nextTokenOf(slot) {
  const list = Array.isArray(slot.next_token) ? slot.next_token : [slot.next_token]
  const first = list[0]
  return typeof first === 'object' && first !== null ? first : null
}

/** Summarize /props into display-safe fields. */
function normalizeProps(props) {
  if (typeof props !== 'object' || props === null) return null
  const model = typeof props.model === 'object' && props.model !== null ? props.model : undefined
  // llama.cpp reports the loaded context per slot here; `/props.model.n_ctx`
  // exists only on builds that expose a model object.
  const nCtx = typeof model?.n_ctx === 'number'
    ? model.n_ctx
    : typeof props.default_generation_settings?.n_ctx === 'number' ? props.default_generation_settings.n_ctx : undefined
  const alias = typeof props.model_alias === 'string' && props.model_alias !== '' ? props.model_alias : undefined
  const fromPath = typeof props.model_path === 'string' && props.model_path !== ''
    ? (props.model_path.includes('/') ? props.model_path.slice(props.model_path.lastIndexOf('/') + 1) : props.model_path)
    : null
  // The server's own default output cap (`-1` means "until the context or a
  // stop condition"); only a positive value is a cap the harness can honour.
  const params = props.default_generation_settings?.params
  const defaultMaxTokens = firstPositive(params?.n_predict, params?.max_tokens)
  const inputModalities = ['text']
  if (props.modalities?.vision === true) inputModalities.push('image')
  return {
    model: typeof model?.id === 'string' ? model.id : alias ?? fromPath,
    aliases: Array.isArray(model?.aliases) ? model.aliases : null,
    totalSlots: typeof props.total_slots === 'number' ? props.total_slots : null,
    buildInfo: typeof props.build_info === 'string' ? props.build_info : null,
    isSleeping: typeof props.is_sleeping === 'boolean' ? props.is_sleeping : null,
    inputModalities,
    ...(typeof nCtx === 'number' && nCtx > 0 ? { nCtx } : {}),
    ...(defaultMaxTokens === null ? {} : { defaultMaxTokens }),
  }
}

/**
 * Instant rate over the retained sample window; falls back to the lifetime
 * gauge. Counter resets (negative delta) discard the stale window.
 */
function instantRate(origin, key, secondsKey, gauge, now) {
  const window = samples.get(origin) ?? []
  const current = window[window.length - 1]
  if (current === undefined || current[key] === undefined || current[secondsKey] === undefined) return gauge ?? null
  for (let i = window.length - 2; i >= 0; i -= 1) {
    const older = window[i]
    if (now - older.t < SAMPLE_MIN_SPAN_MS) continue
    const dTokens = current[key] - older[key]
    const dSeconds = current[secondsKey] - older[secondsKey]
    if (dTokens < 0 || dSeconds < 0) { samples.set(origin, [current]); return null }
    if (dSeconds <= 0) continue
    return Math.round((dTokens / dSeconds) * 10) / 10
  }
  return gauge ?? null
}

/**
 * The readings payload for a confirmed llama.cpp origin: `/metrics` and
 * `/slots` in one round trip. Only served while the client's dialog is open.
 */
async function liveSnapshot(origin, verdict, auth = {}) {
  const [metricsText, slotsBody] = await Promise.all([
    verdict.metricsEnabled ? fetchText(`${origin}/metrics`, LIVE_TIMEOUT_MS, auth) : Promise.resolve(null),
    fetchJson(`${origin}/slots`, LIVE_TIMEOUT_MS, auth),
  ])
  if (metricsText === null && slotsBody === null) return null // server unreachable right now

  const parsed = metricsText === null ? null : parseMetrics(metricsText)
  const slots = normalizeSlots(slotsBody)
  const props = verdict.props

  const now = Date.now()
  if (slots !== null) rateSlots(origin, slots.rows, now)
  const metrics = deriveMetrics(origin, parsed === null ? null : parsed.sums, parsed === null ? [] : parsed.raw, parsed === null ? 0 : parsed.rawTotal, now)

  const body = {
    state: 'llama',
    online: true,
    metricsEnabled: metrics !== null,
    servedModel: props?.model ?? null,
    servedModelMatches: null,
    props: props ?? null,
    slots: slots ?? null,
    metrics,
    progressLive: liveProgress(),
    // The traces are the one thing here the dialog cannot show; they stay in
    // the payload so a curl can answer "why is the context pill stale?".
    debug: { contextTrace, effortTrace, request: requestTrace },
    updatedAt: now,
  }
  lastLiveAt.set(origin, now)
  return body
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/* ---------------- llama.cpp provider adapter ---------------- */

/**
 * Live per-request progress, teed from the SSE `prompt_progress`/`timings`
 * chunks of calls this adapter dispatches. Key: `<provider>|<sessionId>|<seq>`
 * (one per in-flight request, not per session — see llamaStream). This is the
 * exact data the llama.cpp webui renders as "Processing 28% (ETA: 12s)" — only
 * the request owner can see it, and on this route the request owner is us.
 * @type {Map<string, object>}
 */
const progress = new Map()
/**
 * `provider|session` -> `{ startedAt, seenAt }`: when a task's FIRST request was
 * seen. Rows are ordered by task, not by request, so an agent taking its fifth
 * turn keeps the place it has held all along instead of hopping down the list.
 * @type {Map<string, { startedAt: number, seenAt: number }>}
 */
const taskStarts = new Map()
let requestSeq = 0

/** The identity of a task: one session of one provider. */
function taskKeyFor(provider, sessionId) {
  return provider + '|' + String(sessionId ?? 'anon')
}

/**
 * origin -> { total, byTask, bySlot }: stable session-to-slot pins.
 *
 * llama.cpp picks an unpinned request's slot by prompt similarity, so sessions
 * that share a long system prompt and tools can steal each other's slot and
 * discard its KV cache. A pinned `id_slot` gives each session a stable slot;
 * auxiliary calls use an unassigned slot when one is free so they do not evict a
 * conversation's cache.
 *
 * @type {Map<string, { total: number, byTask: Map<string, { slot: number, lastSeen: number }>, bySlot: Map<number, string> }>}
 */
const slotAssignments = new Map()

/** The slot to pin this request to, or undefined when affinity is unavailable. */
function slotForRequest(origin, options, catalog) {
  const total = catalog?.totalSlots
  if (!Number.isInteger(total) || total < 2 || options.sessionId === undefined) return undefined
  let state = slotAssignments.get(origin)
  if (state === undefined || state.total !== total) {
    state = { total, byTask: new Map(), bySlot: new Map() }
    slotAssignments.set(origin, state)
  }
  const now = Date.now()
  // Compaction is different from other auxiliary calls: DSH replays the
  // conversation prefix and appends the instruction, so the session's own slot
  // has the warm KV prefix. Session-title calls do not share that prefix.
  const wantsSessionSlot = options.purpose === undefined || options.purpose === 'compaction'
  if (!wantsSessionSlot) {
    if (state.bySlot.size < total) {
      for (let slot = 0; slot < total; slot++) {
        if (!state.bySlot.has(slot)) return slot
      }
    }
    return undefined
  }
  const key = taskKeyFor(options.provider, options.sessionId)
  const pinned = state.byTask.get(key)
  if (pinned !== undefined) {
    pinned.lastSeen = now
    return pinned.slot
  }
  let slot = -1
  for (let candidate = 0; candidate < total; candidate++) {
    if (!state.bySlot.has(candidate)) {
      slot = candidate
      break
    }
  }
  if (slot === -1) {
    // Every slot is assigned: reuse the least recently seen *idle* session. A
    // sub-agent that is still generating keeps its slot; if every slot is
    // active, leave this request unpinned rather than evicting live work.
    const active = new Set()
    for (const entry of progress.values()) {
      if (entry.endedAt === null) active.add(taskKeyFor(entry.provider, entry.sessionId))
    }
    let oldestKey = null
    let oldestAt = Infinity
    for (const [task, entry] of state.byTask) {
      if (active.has(task)) continue
      if (entry.lastSeen < oldestAt) {
        oldestAt = entry.lastSeen
        oldestKey = task
      }
    }
    if (oldestKey === null) return undefined
    const evicted = state.byTask.get(oldestKey)
    state.byTask.delete(oldestKey)
    state.bySlot.delete(evicted.slot)
    slot = evicted.slot
  }
  state.byTask.set(key, { slot, lastSeen: now })
  state.bySlot.set(slot, key)
  return slot
}

/** Progress entries fresh enough to display; prunes leaked entries (aborts). */
function liveProgress() {
  const now = Date.now()
  const out = []
  for (const [key, entry] of progress) {
    // A finished request lingers for HOLD_MS so a task between turns keeps its
    // row; a live one that has reported nothing for two minutes is a leak (a
    // killed generator, a socket that never closed).
    const endedAt = entry.endedAt ?? null
    if (endedAt === null ? now - entry.updatedAt > 120_000 : now - endedAt > HOLD_MS) {
      progress.delete(key)
      rateWindows.delete(key)
      continue
    }
    out.push(entry)
  }
  // Session memory for row positions, kept while the session is around and
  // dropped once it has been quiet long enough to be forgotten.
  const alive = new Set(out.map((entry) => taskKeyFor(entry.provider, entry.sessionId)))
  for (const [key, task] of taskStarts) {
    if (alive.has(key)) task.seenAt = now
    else if (now - task.seenAt > TASK_KEEP_MS) taskStarts.delete(key)
  }
  return out
}

/**
 * Name the task each in-flight request belongs to, for the dialog's "what"
 * column: a sub-agent's durable creation label, else its session's title.
 *
 * **Where the names live:** `@deepseek-ai/dsh-subagent` projects the child's own
 * descriptor as `subagent: { mode, label? }` and `@deepseek-ai/dsh-session-title`
 * projects `title: string | null`, both readable through `sessionProjections`.
 * `cachedSnapshot` is the right read: synchronous, from the watermark cache, and
 * it never folds a session's history length into a poll.
 *
 * **Why opportunistic:** a profile without those packages still routes llama.cpp
 * requests, so every service is reached through the non-strict `ctx.get` (which
 * yields `undefined` rather than throwing) and any failure leaves the label
 * empty. Nothing here may touch the request path.
 *
 * **Why throttled:** a session title is usually generated DURING the turn it
 * names, so a once-at-creation lookup would miss it; retrying on every client
 * poll would read the projections 2x/s forever for nameless sessions.
 *
 * @param ctx - the plugin context, used only for opportunistic service reads.
 */
function labelProgress(ctx) {
  const now = Date.now()
  for (const entry of progress.values()) {
    if (entry.sessionLabel !== null || now - entry.labelAt < LABEL_RETRY_MS) continue
    entry.labelAt = now
    if (entry.sessionId === null) continue
    try {
      const service = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
      const session = service('sessions')?.get(entry.sessionId)
      const projections = service('sessionProjections')
      if (session === undefined || session === null || projections === undefined) continue
      // One key per read: `cachedSnapshot` answers from the LOWEST COMMON cached
      // cut, so asking for both keys at once can drop the one that is warm.
      const subagent = projections.cachedSnapshot(session, ['subagent'])?.values?.subagent
      if (typeof subagent?.label === 'string' && subagent.label !== '') {
        entry.sessionKind = 'subagent'
        entry.sessionLabel = subagent.label
        continue
      }
      const title = projections.cachedSnapshot(session, ['title'])?.values?.title
      if (typeof title === 'string' && title !== '') {
        entry.sessionKind = 'session'
        entry.sessionLabel = title
      }
    } catch { /* a name is a nicety: never let it reach the request */ }
  }
}

/**
 * Model discovery and the per-origin server readings share these timeouts. The
 * catalog carries what llama.cpp reports about itself: `/v1/models` and `/props`
 * are read together, so a server that lists no models still contributes its alias,
 * context window, and default output cap.
 */
const CATALOG_TTL_MS = 60_000
/** Retry delay for a catalog fetch that came back empty (server down/starting). */
const CATALOG_FAIL_TTL_MS = 5_000
const CATALOG_TIMEOUT_MS = 2500

/**
 * Fallback levels for a template that accepts `reasoning_effort` but does not
 * enumerate the values it understands. The standard four levels, default
 * `medium`; `minimal` is not part of this fallback.
 */
const STANDARD_EFFORTS = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
]
const STANDARD_DEFAULT = 'medium'
const STANDARD_LEVELS = new Set(['none', 'low', 'medium', 'high'])

/** Display names for the levels llama.cpp templates name; unknown IDs are title-cased. */
const EFFORT_NAMES = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  on: 'On',
}

/** Presentation order; the server list is sorted least to greatest. */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Values that mean "do not think", whichever spelling a template uses. */
const OFF_ALIASES = new Set(['none', 'off', 'no_think', 'nothink', 'no-think', 'disabled'])
const KNOWN_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'no_think', 'off', 'disabled'])

function normalizeEffortLevel(value) {
  const token = String(value).trim().toLowerCase()
  return OFF_ALIASES.has(token) ? 'none' : token
}

function effortName(id) {
  const known = EFFORT_NAMES[id]
  if (known !== undefined) return known
  return id.replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

function effortRank(id) {
  const index = EFFORT_ORDER.indexOf(id)
  return index === -1 ? EFFORT_ORDER.length : index
}

function standardEffortCatalog() {
  return { mode: 'standard', levels: new Set(STANDARD_LEVELS), defaultLevel: STANDARD_DEFAULT, offValue: 'none' }
}

/**
 * How this server exposes reasoning choices.
 *
 * - `server`: a parsed vocabulary and default from the chat template.
 * - `standard`: the template accepts `reasoning_effort` but never rejects an
 *   unknown value, so there is nothing to enumerate; offer the four standard
 *   levels, default medium.
 * - `thinking`: no effort vocabulary, but the template reads `enable_thinking`;
 *   offer off/on.
 * - `none`: no server-advertised reasoning control.
 *
 * @type {Map<string, { mode: 'server'|'standard'|'thinking'|'none', levels: Set<string>, defaultLevel: string|null, offValue: string }>}
 */
const effortCatalog = new Map()

/**
 * Parse the level list out of a chat-template rejection.
 *
 * llama.cpp templates name their values in several shapes:
 * `Supported types are xhigh (default), medium, and low.`,
 * `Supported values: high, medium, low.`, and
 * `should be no_think/low/high`. The last shape is only accepted when it names
 * at least one effort-like value, so an unrelated template error does not
 * become a vocabulary.
 *
 * @param text - the `/apply-template` response body.
 * @returns `{ levels, defaultLevel, offValue }`, or null when no list is present.
 */
function parseEffortOffer(text) {
  const source = String(text)
  const strong = /supported\s+(?:types|values)(?:\s+are)?\s*:?\s*([^."\\\n]+)/i.exec(source)
  const weak = strong === null ? /should\s+be\s*:?\s*([^."\\\n]+)/i.exec(source) : null
  const match = strong ?? weak
  if (match === null) return null
  const raw = match[1]
  const defaultMatch = /([a-z][a-z0-9_-]*)\s*\(default\)/i.exec(raw)
  const levels = new Set()
  const known = new Set()
  let offValue = null
  for (const part of raw.split(/\s*(?:,|\/|\||\band\b)\s*/i)) {
    const token = part.replace(/\(default\)/gi, '').trim().toLowerCase()
    if (!/^[a-z][a-z0-9_-]*$/.test(token)) continue
    if (token === 'default' || token === 'types' || token === 'values' || token === 'are' || token === 'should' || token === 'be' || token === 'or') continue
    if (OFF_ALIASES.has(token)) {
      levels.add('none')
      if (offValue === null) offValue = token
      known.add('none')
      continue
    }
    levels.add(token)
    if (KNOWN_EFFORTS.has(token)) known.add(token)
  }
  // One named level is a parse accident, not a vocabulary; treat it as unknown.
  if (![...levels].some((level) => level !== 'none')) return null
  if (weak !== null && known.size === 0) return null
  levels.add('none')
  const defaultLevel = defaultMatch === null ? null : normalizeEffortLevel(defaultMatch[1])
  return {
    levels,
    defaultLevel: defaultLevel !== null && levels.has(defaultLevel) ? defaultLevel : null,
    offValue: offValue ?? 'none',
  }
}

/**
 * Ask the server which `reasoning_effort` values its chat template accepts, by
 * rendering one throwaway prompt through `/apply-template` with a bogus value.
 * The template's own rejection is authoritative, needs no model load, and costs
 * one short request per catalog refresh.
 *
 * @param origin - llama.cpp endpoint origin.
 * @param auth - authorization headers for this operation.
 * @returns the parsed offer, or null when the template names no list.
 */
async function probeEfforts(origin, auth = {}) {
  let text = null
  try {
    const res = await globalThis.fetch(`${origin}/apply-template`, {
      method: 'POST',
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json', ...auth },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'probe' }],
        add_generation_prompt: true,
        reasoning_effort: 'dsh-llm-llamacpp-probe',
        // Some templates only validate the effort inside their thinking branch.
        chat_template_kwargs: { enable_thinking: true },
      }),
    })
    text = await res.text()
  } catch {
    return null
  }
  return parseEffortOffer(text)
}

/** Does this server's template accept a leading system message? */
async function probeSystemRole(origin, auth = {}) {
  try {
    const res = await globalThis.fetch(`${origin}/apply-template`, {
      method: 'POST',
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json', ...auth },
      body: JSON.stringify({
        messages: [{ role: 'system', content: 'probe' }, { role: 'user', content: 'probe' }],
        add_generation_prompt: true,
      }),
    })
    return res.ok
  } catch {
    return null
  }
}

/**
 * The reasoning descriptor the harness validates efforts against.
 *
 * `server` is dynamic; `standard` and `thinking` are fallbacks for templates
 * whose choices cannot be enumerated. `none` omits the field entirely.
 *
 * @param origin - llama.cpp endpoint origin.
 * @returns `{ efforts, defaultEffort? }`, or undefined when the server exposes no control.
 */
function reasoningInfo(origin) {
  const catalog = effortCatalog.get(origin)
  if (catalog === undefined) return undefined
  if (catalog.mode === 'standard') return { efforts: STANDARD_EFFORTS, defaultEffort: STANDARD_DEFAULT }
  if (catalog.mode === 'thinking') {
    return {
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'on', name: 'On' },
      ],
    }
  }
  if (catalog.mode !== 'server') return undefined
  const efforts = [{ id: 'off', name: 'Off' }]
  const values = [...catalog.levels].filter((level) => level !== 'none')
  values.sort((a, b) => effortRank(a) - effortRank(b) || a.localeCompare(b))
  for (const value of values) efforts.push({ id: value, name: effortName(value) })
  if (efforts.length === 1) return undefined
  const defaultEffort = catalog.defaultLevel === null ? null : catalog.defaultLevel === 'none' ? 'off' : catalog.defaultLevel
  return {
    efforts,
    ...(defaultEffort !== null && efforts.some((effort) => effort.id === defaultEffort) ? { defaultEffort } : {}),
  }
}

/**
 * Resolve one offered effort onto the request body.
 *
 * The harness validates the selection against {@link reasoningInfo} before the
 * request reaches here, so a server level can be sent verbatim. `off` uses the
 * server's own disable spelling (`none`, or `no_think` on templates that name it).
 *
 * @param origin - llama.cpp endpoint origin.
 * @param effort - the harness effort id, or undefined.
 * @returns `{ effort }` or `{ thinking }` to send, or `{ omit: true }` for nothing.
 */
function resolveEffort(origin, effort) {
  if (typeof effort !== 'string' || effort === '') return { omit: true }
  const catalog = effortCatalog.get(origin)
  if (effort === 'off') return { effort: catalog?.offValue ?? 'none' }
  if (catalog === undefined) return { omit: true }
  if (catalog.mode === 'thinking') return effort === 'on' ? { thinking: true } : { omit: true }
  if ((catalog.mode === 'server' || catalog.mode === 'standard') && catalog.levels.has(effort)) return { effort }
  return { omit: true }
}

/**
 * Apply the resolved effort to a request body. The off spelling is sent as
 * `reasoning_effort`; `none` is handled by the server, and other spellings are
 * read by the template.
 */
function applyEffort(body, resolved) {
  if (resolved.effort !== undefined) body.reasoning_effort = resolved.effort
  else if (resolved.thinking !== undefined) body.chat_template_kwargs = { enable_thinking: resolved.thinking }
}

/** route -> { provider, alias, baseURL, origin, apiKeyEnv } */

/** Stream idle ceiling; pi-ai's default is the same 300 s. 0 disables the guard. */
let streamIdleMs = 300_000
/**
 * `request key` -> the sample rings behind its current-speed rates. Kept out of
 * the entry itself so nothing sample-shaped can reach the payload.
 * @type {Map<string, { prompt: { fresh: number, timeMs: number }[], decode: { n: number, ms: number }[] }>}
 */
const rateWindows = new Map()
/**
 * The KEY SET of the last request this adapter was handed.
 *
 * What the harness actually passes is not something the type declarations can
 * answer: `GenerateOptions` is a declaration, and an adapter may read a field the
 * types do not mention (the shipped pi-ai adapter reads `options.id`). So the
 * question "does the loop ever ask for a forced tool call?" is answered from the
 * payload, with names only — never values.
 */
let requestTrace = { at: null, provider: null, model: null, purpose: null, keys: [] }
/** origin -> { at, ttlMs, models, contextWindow, contextSource, defaultMaxTokens, mediaMarker? } */
const catalogs = new Map()
/**
 * origin -> the server's own context capacity, recorded whenever `/props` is
 * read. The catalog carries the same number from the same probe; this map keeps
 * the last known value for a resolution that races the cache.
 */
const probedContextWindows = new Map()
/**
 * Last context resolution, surfaced in the route payload for the
 * "context-used pill vanished" class of bug: the pill needs
 * `request/context.contextWindow`, which the harness only records from
 * `prepareCall().context`, and this adapter is its only source.
 * @type {{ at: number, provider: string, model: string, contextWindow: number|null, source: string } | null}
 */
let contextTrace = null
/**
 * Last reasoning-catalog result, surfaced in the route payload: whether the
 * template reads `reasoning_effort`, which mode was chosen, and what it offers.
 * @type {{ at: number, origin: string, supportsReasoningEffort: boolean|null, mode: string|null, levels: string[]|null, defaultLevel: string|null, offValue: string|null } | null}
 */
let effortTrace = null

function blocksText(blocks) {
  const parts = []
  for (const block of blocks ?? []) if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  return parts.join('\n\n')
}

/**
 * Concatenate the assistant's reasoning blocks for replay.
 *
 * llama.cpp's `reasoning_content` field is what its chat template preserves on
 * assistant turns. Dropping it makes the next prompt differ from the previous
 * generation and, more importantly, leaves the harness token meter pricing
 * content the model never sees.
 */
function blocksReasoning(blocks) {
  const parts = []
  for (const block of blocks ?? []) {
    if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/**
 * Whether one assistant message was produced by the route being called.
 *
 * Reasoning is model-specific: replaying another model's thinking can poison the
 * prompt, and pi-ai drops it under the same rule. Messages with no attribution
 * are accepted for compatibility with older session logs.
 */
function sameModelSource(message, options) {
  const source = message?.source
  if (source !== undefined) {
    return source?.kind === 'model' && source.provider === options.provider && source.model === options.model
  }
  if (message?.provider !== undefined || message?.model !== undefined) {
    return message.provider === options.provider && message.model === options.model
  }
  return true
}

/**
 * One user image as an OpenAI content part, projected through the route's own
 * request target.
 *
 * **Why the projection:** the harness owns the image byte budget, resize ladder
 * and variant cache in `attachments.readImageRequest(ref, target)`. The media
 * type comes from the *stored* reference's `mediaType`: `ImageAttachmentRef` has
 * no `mimeType`, so `image/png` must not be assumed.
 *
 * An `offloaded` block is never re-sent: the harness decided those bytes stay
 * out of the request (see `dsh-llm`'s `collectImageRefs`).
 *
 * @param ctx - host context owning `llm`/`attachments`.
 * @param options - the assembled request, for `provider`/`model`/`signal`.
 * @param block - one `image` content block.
 * @returns an `image_url` part, or a text placeholder when unavailable.
 */
function imageIdentity(ref) {
  return ref.name === undefined ? String(ref.attachmentId) : `${JSON.stringify(ref.name)} (${ref.attachmentId})`
}

function imageExtension(mediaType) {
  if (mediaType === 'image/jpeg') return '.jpg'
  if (mediaType === 'image/webp') return '.webp'
  if (mediaType === 'image/gif') return '.gif'
  return '.png'
}

/** Resolve the normalized image's execution-world path when the host exposes one. */
function imageAccessPath(ctx, ref) {
  try {
    const hostPath = ctx.attachments?.imageHostPath?.(ref)
    if (typeof hostPath === 'string' && hostPath !== '') return ctx.get?.('fs')?.processPathFromHostPath?.(hostPath)
  } catch { /* no execution-world mapping */ }
  return undefined
}

function normalizedImageAccessText(ref, readonlyPath) {
  return ` Normalized copy (read-only; may be resized or re-encoded): ${JSON.stringify(readonlyPath)} (${ref.width}x${ref.height}px, ${ref.mediaType}). Source dimensions, format, and byte size may differ. Copy to a writable path ending in ${imageExtension(ref.mediaType)} before editing.`
}

/** pi-ai's model-facing handle for one request image, including its path when the host exposes one. */
function imageHandleText(ctx, ref, version) {
  const preview = `Image ${imageIdentity(ref)}; request preview ${version.width}x${version.height}px.`
  const readonlyPath = imageAccessPath(ctx, ref)
  if (typeof readonlyPath !== 'string' || readonlyPath === '') {
    return `${preview} It may be resized or re-encoded; source dimensions, format, and byte size may differ.`
  }
  return `${preview}${normalizedImageAccessText(ref, readonlyPath)}`
}

/** pi-ai's model-facing placeholder for an image omitted by the request budget. */
function offloadedImageText(ctx, ref) {
  const identity = `image omitted to fit request image limits; ${imageIdentity(ref)}.`
  const readonlyPath = imageAccessPath(ctx, ref)
  if (typeof readonlyPath !== 'string' || readonlyPath === '') {
    return `[${identity} No local normalized image path is available; ask the user to attach it again if needed.]`
  }
  return `[${identity}${normalizedImageAccessText(ref, readonlyPath)}]`
}

/**
 * Convert one image block. pi-ai sends a model-facing handle beside the image
 * (identity, request size, and the normalized path when available), so callers
 * place that text next to the image part.
 */
async function openAiImagePart(ctx, options, block) {
  const ref = block.attachment
  if (block.offloaded === true) return { part: { type: 'text', text: offloadedImageText(ctx, ref) }, handle: null }
  try {
    const target = typeof ctx.llm?.imageRequestTarget === 'function'
      ? ctx.llm.imageRequestTarget(options.provider, options.model, ref)
      : { width: ref.width, height: ref.height, maxBytes: ref.bytes }
    const version = await ctx.attachments.readImageRequest(ref, target, options.signal)
    const mime = typeof version?.mediaType === 'string' && version.mediaType !== '' ? version.mediaType : 'image/png'
    return {
      part: { type: 'image_url', image_url: { url: `data:${mime};base64,${Buffer.from(version.data).toString('base64')}` } },
      handle: imageHandleText(ctx, ref, version),
    }
  } catch {
    return { part: { type: 'text', text: '[image unavailable]' }, handle: null }
  }
}

/** The harness's text stand-in for a file block, so the model can still reach the file. */
function fileHandleText(ctx, ref) {
  try {
    const text = ctx.llm?.fileRequestText?.(ref)
    if (typeof text === 'string' && text !== '') return text
  } catch { /* not a host-backed file */ }
  return '[file omitted]'
}

/** Assemble the OpenAI messages array from dsh's block-shaped history. */
async function toOpenAiMessages(ctx, options, systemRole = true) {
  const out = []
  // Tool-result images cannot ride on an OpenAI `tool` message. pi-ai sends the
  // text result on the tool message and follows a run of tool results with one
  // user message carrying the images, so this adapter does the same.
  let toolImages = []
  let pendingSystem = ''
  let lastUser = null
  const prependText = (message, text) => {
    if (typeof message.content === 'string') {
      message.content = message.content === '' ? text : `${text}\n\n${message.content}`
    } else if (Array.isArray(message.content)) {
      message.content.unshift({ type: 'text', text })
    } else {
      message.content = text
    }
  }
  const appendLeadingSystem = (content) => {
    if (out.length > 0 && out[0].role === 'system' && typeof out[0].content === 'string') {
      out[0].content = out[0].content === '' ? content : `${out[0].content}\n\n${content}`
    } else {
      out.push({ role: 'system', content })
    }
  }
  const flushToolImages = () => {
    if (toolImages.length === 0) return
    const message = { role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, ...toolImages] }
    out.push(message)
    lastUser = message
    toolImages = []
  }
  if (typeof options.system === 'string' && options.system !== '') {
    if (systemRole) appendLeadingSystem(options.system)
    else pendingSystem = options.system
  }
  let sawNonSystem = false
  for (const msg of options.messages ?? []) {
    if (typeof msg?.role !== 'string') continue
    if (msg.role !== 'system') sawNonSystem = true
    if (msg.role !== 'tool') flushToolImages()
    if (msg.role === 'user') {
      const parts = []
      for (const block of msg.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push({ type: 'text', text: block.text })
        else if (block?.type === 'image' && block.attachment != null) {
          const { part, handle } = await openAiImagePart(ctx, options, block)
          if (handle !== null) parts.push({ type: 'text', text: handle })
          parts.push(part)
        } else if (block?.type === 'file' && block.attachment != null) parts.push({ type: 'text', text: fileHandleText(ctx, block.attachment) })
      }
      if (parts.length === 0 && pendingSystem === '') continue
      if (pendingSystem !== '') {
        if (parts[0]?.type === 'text') {
          parts[0] = { type: 'text', text: `${pendingSystem}\n\n${parts[0].text}` }
        } else {
          parts.unshift({ type: 'text', text: pendingSystem })
        }
        pendingSystem = ''
      }
      const message = { role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts }
      out.push(message)
      lastUser = message
    } else if (msg.role === 'assistant') {
      const text = blocksText(msg.content)
      const reasoning = sameModelSource(msg, options) ? blocksReasoning(msg.content) : ''
      const calls = (msg.content ?? []).filter(b => b?.type === 'tool-call').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments ?? '' } }))
      if (text === '' && calls.length === 0 && reasoning === '') continue
      out.push({
        role: 'assistant',
        content: text === '' ? null : text,
        ...(reasoning === '' ? {} : { reasoning_content: reasoning }),
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      })
    } else if (msg.role === 'tool') {
      const texts = []
      const images = []
      for (const block of msg.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') texts.push(block.text)
        else if (block?.type === 'image' && block.attachment != null) {
          const { part, handle } = await openAiImagePart(ctx, options, block)
          if (handle !== null) texts.push(handle)
          if (part.type === 'image_url') images.push(part)
          else if (typeof part.text === 'string' && part.text !== '') texts.push(part.text)
        }
      }
      const text = texts.join('\n')
      const content = text !== '' ? text : images.length > 0 ? '(see attached image)' : '(no tool output)'
      out.push({ role: 'tool', tool_call_id: msg.toolCallId, content })
      if (images.length > 0) toolImages.push(...images)
    } else if (msg.role === 'system') {
      const content = blocksText(msg.content)
      if (content !== '') {
        // llama.cpp chat templates reject a system message after the
        // conversation starts (Qwen raises "System message must be at the
        // beginning"). Keep one leading system and fold a later update into the
        // next user turn, which preserves strict user/assistant alternation.
        if (sawNonSystem || !systemRole) pendingSystem = pendingSystem === '' ? content : `${pendingSystem}\n\n${content}`
        else appendLeadingSystem(content)
      }
    }
  }
  flushToolImages()
  if (pendingSystem !== '') {
    if (lastUser !== null) prependText(lastUser, pendingSystem)
    else out.push({ role: 'user', content: pendingSystem })
  }
  return out
}

/**
 * The session's routed reasoning effort when a request left the effort at the
 * model default.
 *
 * This is the llama.cpp counterpart of pi-ai's `options.reasoningEffort ??
 * profile.reasoning`: a caller that does not choose an effort gets a route-level
 * default rather than an arbitrary template value. Here the default is the
 * effort of the session's last routed request, so auxiliary calls (compaction,
 * titles, other one-shots) render the same chat-template prefix as the
 * conversation they continue and reuse its KV cache. An explicit non-default
 * effort is never replaced, a different provider/model keeps its own default,
 * and a request without a session is unchanged.
 *
 * @param ctx - plugin context; `sessions` is read opportunistically.
 * @param options - the stream request handed to the adapter.
 * @param routeEntry - the declared route serving this request.
 * @returns the inherited effort, or undefined when the request is not defaulted.
 */
function sessionRoutedEffort(ctx, options, routeEntry) {
  if (options.sessionId === undefined) return undefined
  const defaultEffort = reasoningInfo(routeEntry.origin)?.defaultEffort
  const requested = options.reasoningEffort
  const atDefault = requested === undefined
    || (typeof defaultEffort === 'string' && requested === defaultEffort)
  if (!atDefault) return undefined
  try {
    const session = ctx.get?.('sessions')?.get(options.sessionId)
    const config = session?.requestHeader?.()?.config
    if (config?.provider !== routeEntry.provider || config?.model !== options.model) return undefined
    return typeof config.reasoningEffort === 'string' && config.reasoningEffort !== '' ? config.reasoningEffort : undefined
  } catch {
    return undefined
  }
}

function closeBlock(block) {
  if (block.kind === 'text') return { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
  if (block.kind === 'reasoning') return { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
  return { type: 'block-end', index: block.index, block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.args } }
}

/**
 * Split complete SSE frames out of a body buffer.
 *
 * **Frames, not lines:** RFC 8895 terminates a message with a blank line and
 * allows its data to span several `data:` lines, so an event is only complete
 * once that blank line arrives; `llama.cpp` writes exactly one `data: <json>\n\n`
 * per result (`format_oai_sse`) and uses `:\n\n` comment pings to hold the
 * connection open, which parse to nothing here.
 *
 * **Cost:** one pass over the buffer and one slice per line, plus a single slice
 * of the unconsumed tail per read. Lines of an incomplete frame stay in the
 * buffer (`rest`) and are re-scanned by the next read, which is what keeps a
 * frame split across chunk boundaries intact.
 *
 * @param buffer - decoded body text, including any partial frame.
 * @returns `{ payloads, rest }` — payloads need `JSON.parse`, `rest` is the tail.
 */
function takeSsePayloads(buffer) {
  const payloads = []
  let current = null
  let start = 0
  // Everything before `safe` is fully consumed: the tail keeps only what a later
  // read can still complete.
  let safe = 0
  for (;;) {
    const nl = buffer.indexOf('\n', start)
    if (nl < 0) break
    const raw = buffer.slice(start, nl)
    start = nl + 1
    // A CRLF server is legal: drop the carriage return rather than the frame.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') {
      if (current !== null) {
        payloads.push(current)
        current = null
      }
      safe = start
    } else if (line.startsWith('data:')) {
      // The spec strips ONE leading space, not arbitrary whitespace.
      const value = line.charCodeAt(5) === 32 ? line.slice(6) : line.slice(5)
      current = current === null ? value : current + '\n' + value
    }
  }
  return { payloads, rest: buffer.slice(safe) }
}

/**
 * The server's own failure report, when one arrives inside a 200 stream.
 *
 * @param chunk - one parsed SSE payload (or a parsed error body).
 * @returns `"<message> (<type>)"`, or null when this is not an error envelope.
 */
function serverFailure(chunk) {
  if (typeof chunk !== 'object' || chunk === null) return null
  const error = chunk.error
  if (typeof error === 'string') return error === '' ? null : error
  if (typeof error !== 'object' || error === null) return null
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : JSON.stringify(error)
  const type = typeof error.type === 'string' && error.type !== '' ? ` (${error.type})` : ''
  return message + type
}

/**
 * Build a failure the harness can route on.
 *
 * The runtime only trusts a code on its own `HarnessError`; a duck-typed
 * adapter's plain error becomes `UNKNOWN` and is never retried. A data-backed
 * `failure` snapshot whose code matches the error's own is the supported escape
 * hatch, so both are set. No harness import is needed.
 *
 * @param message - human-readable reason, shown to the user.
 * @param code - harness taxonomy code.
 * @returns the error to throw.
 */
function adapterFailure(message, code) {
  const error = new Error(message)
  error.code = code
  error.failure = Object.freeze({ message, code })
  return error
}

/**
 * Classify provider wording that a status code cannot express, mirroring
 * `dsh-llm`'s `isContextWindowExceededError` / `isQuotaExceededError` tests (copied
 * rather than imported, because the host half must not import harness packages).
 *
 * llama.cpp reports an oversized prompt as `exceed_context_size_error`, which the
 * harness reacts to by compacting — reporting it as a generic failure instead would
 * end the turn.
 *
 * @param detail - the server's error text, with its type appended when present.
 * @returns the harness code, or null when this is nothing special.
 */
function classifyDetail(detail) {
  if (typeof detail !== 'string' || detail === '') return null
  if (/exceed_context_size_error/i.test(detail)
    || /\bcontext[\s_-](?:length|window)[\s_-](?:exceed(?:ed|s)?|overflow(?:ed)?)/i.test(detail)
    || /\b(?:input|prompt|request|messages?)\b.{0,40}\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}\bcontext\b/i.test(detail)
    || /\b(?:maximum|max)\s+context\s+(?:length|window)\b/i.test(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (/\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)) return 'QUOTA'
  return null
}

/**
 * Map an HTTP status onto the harness taxonomy (`dsh-llm-pi-ai` classifies the same
 * conditions from message text; a status is authoritative where we have one).
 *
 * @param status - the response status.
 * @returns the harness code.
 */
function codeForStatus(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400 || status === 413 || status === 422) return 'INVALID_REQUEST'
  // A 408 is a timeout from the client's point of view, whether it came from a
  // proxy or an intermediary. Retrying is the useful behavior.
  if (status === 408) return 'TIMEOUT'
  if (status >= 500) return 'SERVER'
  return 'LLAMA_CPP_ERROR'
}

/**
 * One body read with a stream idle ceiling, the way pi-ai guards its own stream.
 *
 * A server that stops sending bytes (a wedged slot, a link that died without a
 * reset, a dropped Wi-Fi) otherwise hangs the turn until the user aborts. A timeout
 * is `TIMEOUT`, which the harness retries.
 *
 * @param reader - the response body reader.
 * @param idleMs - ceiling in milliseconds; 0 disables it.
 * @returns the read result.
 */
async function readWithIdle(reader, idleMs) {
  if (!(idleMs > 0)) return reader.read()
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(adapterFailure(`llama.cpp stream idle for ${idleMs}ms`, 'TIMEOUT')), idleMs)
    if (typeof timer?.unref === 'function') timer.unref()
  })
  const read = reader.read()
  // The race may abandon this read; its later rejection must not go unhandled.
  read.catch(() => {})
  try {
    return await Promise.race([read, guard])
  } finally {
    clearTimeout(timer)
  }
}

/** Read a non-200 error body under the same idle ceiling as the stream. */
async function readResponseText(res, idleMs) {
  if (res.body === null || res.body === undefined) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const { value, done } = await readWithIdle(reader, idleMs)
      if (done) break
      if (value != null) text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    void reader.cancel().catch(() => {})
  }
}

/**
 * Map one llama.cpp OpenAI-shaped `usage` object onto the harness's **disjoint**
 * token buckets.
 *
 * **Why the subtraction:** the harness documents and consumes `inputTokens` as
 * *uncached* input only, and every fold sums `inputTokens + cacheReadTokens +
 * cacheWriteTokens` (`dsh-token-meter`'s `pressureFrom` and `usageTokens`). The
 * stock pi-ai route subtracts the cached prefix out of `prompt_tokens`, and
 * llama.cpp's own Anthropic-shaped usage block does the same
 * (`input_tokens = n_prompt_tokens - n_prompt_tokens_cache`). llama.cpp's
 * OpenAI-shaped `prompt_tokens` **includes** the cached prefix, so passing it
 * through while also reporting `cacheReadTokens` double-counts every cached
 * turn: the context-used pill then reads up to 2x the real prompt size and
 * compaction acts on that inflated pressure.
 *
 * @param usage - one `usage` object from the stream (or undefined).
 * @returns a `usage` StreamChunk, or null when there are no counts to report.
 */
function mapUsage(usage) {
  if (typeof usage !== 'object' || usage === null) return null
  if (typeof usage.prompt_tokens !== 'number' && typeof usage.completion_tokens !== 'number') return null
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  const cached = typeof usage.prompt_tokens_details?.cached_tokens === 'number'
    ? usage.prompt_tokens_details.cached_tokens
    : typeof usage.prompt_cache_hit_tokens === 'number' ? usage.prompt_cache_hit_tokens : 0
  const inputTokens = Math.max(0, promptTokens - cached)
  return {
    type: 'usage',
    usage: {
      inputTokens,
      outputTokens,
      // The disjoint total, which equals the provider's inclusive
      // `prompt_tokens + completion_tokens`.
      totalTokens: inputTokens + outputTokens + cached,
      ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    },
  }
}

/**
 * Break one llama.cpp media marker without changing how the text looks.
 *
 * `mtmd_tokenize` splits the whole rendered prompt on the server's
 * `media_marker` and treats every occurrence as an image slot. A text message
 * or tool result that echoed `/props` therefore makes the next text-only
 * request fail with HTTP 400 "Failed to tokenize prompt". A zero-width space
 * after the marker's first character preserves the visible text but stops the
 * server's substring search. The space must go inside the marker: prefixing it
 * would still leave the exact marker intact one character later.
 */
function defuseMediaMarker(text, marker) {
  if (!text.includes(marker)) return text
  const first = String.fromCodePoint(marker.codePointAt(0))
  return text.split(marker).join(first + '\u200b' + marker.slice(first.length))
}

/**
 * Apply {@link defuseMediaMarker} to every string value in a request body.
 *
 * Object keys are deliberately left alone: a tool schema's property names are
 * structural, and rewriting one would change the schema. Message content,
 * reasoning, tool arguments, tool names/descriptions, and parameter values are
 * values, so they are covered.
 */
function defuseMediaMarkers(value, marker) {
  if (typeof marker !== 'string' || marker === '') return value
  if (typeof value === 'string') return defuseMediaMarker(value, marker)
  if (Array.isArray(value)) return value.map((child) => defuseMediaMarkers(child, marker))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = defuseMediaMarkers(child, marker)
    return out
  }
  return value
}

/** Stream one call, normalizing llama.cpp SSE into dsh StreamChunks. */
async function* llamaStream(ctx, options) {
  const routeEntry = servers.get(options.provider)
  if (routeEntry === undefined) {
    throw adapterFailure(`"${options.provider}" is not a declared llama.cpp route (have: ${[...servers.keys()].sort().join(', ')})`, 'INVALID_REQUEST')
  }
  const catalog = catalogs.get(routeEntry.origin)
  const slot = slotForRequest(routeEntry.origin, options, catalog)
  const body = {
    model: options.model || undefined,
    messages: await toOpenAiMessages(ctx, options, catalog?.systemRole !== false),
    stream: true,
    stream_options: { include_usage: true },
    // The reason this adapter exists: exact prompt progress + per-token timings.
    return_progress: true,
    timings_per_token: true,
  }
  // llama.cpp keys a slot to a DSH session so concurrent sessions cannot steal
  // each other's KV cache through prompt-similarity slot selection.
  if (slot !== undefined) body.id_slot = slot
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  // The harness validates the effort against our advertised levels; the server
  // only accepts its own vocabulary, queried from its chat template.
  // A caller that leaves effort at the model default inherits the session's
  // routed effort (pi-ai's `?? profile.reasoning` fallback, session-scoped),
  // keeping the chat-template prefix and its KV cache consistent.
  const effort = sessionRoutedEffort(ctx, options, routeEntry) ?? options.reasoningEffort
  applyEffort(body, resolveEffort(routeEntry.origin, effort))
  if (typeof options.maxTokens === 'number' && options.maxTokens > 0) body.max_tokens = options.maxTokens
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    // `deferLoading: true` asks the provider to keep the definition out of the
    // model's context for now; pi-ai drops those, and llama.cpp has no deferred
    // loading, so sending them would silently spend prompt tokens the harness
    // meant to defer.
    body.tools = options.tools
      .filter(t => typeof t?.name === 'string' && t.deferLoading !== true)
      .map(t => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? {} } }))
  }
  const auth = await routeHeaders(ctx, routeEntry)
  const headers = { 'content-type': 'application/json', 'user-agent': USER_AGENT, ...auth }

  // Per REQUEST, not per session: concurrent calls on one session (title
  // generation, compaction, parallel turns) must not clobber each other's
  // progress, and one request's cleanup must not blind the pill while
  // another is still running.
  requestTrace = {
    at: Date.now(),
    provider: routeEntry.provider,
    model: typeof options.model === 'string' ? options.model : null,
    purpose: typeof options.purpose === 'string' ? options.purpose : null,
    keys: Object.keys(options).sort(),
  }
  const key = routeEntry.provider + '|' + String(options.sessionId ?? 'anon') + '|' + String(++requestSeq)
  const taskKey = taskKeyFor(routeEntry.provider, options.sessionId)
  const task = taskStarts.get(taskKey)
  const taskStartedAt = task === undefined ? Date.now() : task.startedAt
  taskStarts.set(taskKey, { startedAt: taskStartedAt, seenAt: Date.now() })
  // The sample rings for this request's current-speed rates.
  const windows = { prompt: [], decode: [] }
  rateWindows.set(key, windows)
  const entry = {
    // The key doubles as the client's stable React key for this request's row.
    id: key,
    sessionId: options.sessionId ?? null, provider: routeEntry.provider, model: options.model,
    // Auxiliary calls (`session-title`, `compaction`) are worth naming in the
    // dialog: they are the requests that surprise a reader who is idle.
    purpose: options.purpose ?? null,
    sessionKind: null, sessionLabel: null, labelAt: 0,
    // When the TASK (this session) was first seen, for a stable row order, and
    // how this request ended, for the row it leaves behind while it is held.
    taskStartedAt,
    endedAt: null,
    outcome: null,
    phase: 'prompt', total: null, cache: null, processed: null, timeMs: null,
    decoded: null, promptTps: null, decodeTps: null,
    startedAt: Date.now(), updatedAt: Date.now(),
  }
  progress.set(key, entry)

  let res
  // pi-ai's idle watchdog covers the wait for response headers as well as body
  // reads. Without this, a server that accepts the connection but never answers
  // hangs the turn until the user aborts; the configured idle ceiling must bound
  // both phases.
  let headerTimedOut = false
  let headerTimer = null
  let headerAbort = null
  if (streamIdleMs > 0) {
    headerAbort = new AbortController()
    headerTimer = setTimeout(() => {
      headerTimedOut = true
      headerAbort.abort()
    }, streamIdleMs)
  }
  const headerSignal = headerAbort === null
    ? options.signal
    : options.signal === undefined ? headerAbort.signal : AbortSignal.any([options.signal, headerAbort.signal])
  // llama.cpp's media marker is a sentinel, not text: any exact occurrence in
  // the body is tokenized as an image slot. Defuse the marker the catalog read
  // from `/props` before serializing, so an old tool result cannot wedge the
  // session.
  const requestBody = JSON.stringify(defuseMediaMarkers(body, catalog?.mediaMarker))
  try {
    res = await fetch(routeEntry.baseURL + '/chat/completions', { method: 'POST', headers, body: requestBody, signal: headerSignal })
  } catch (error) {
    progress.delete(key)
    if (headerTimedOut) throw adapterFailure(`llama.cpp stream idle timeout after ${streamIdleMs}ms waiting for response headers`, 'TIMEOUT')
    // An abort is a cancellation, not a transport failure; everything else here is
    // the connection never being made.
    if (error?.name === 'AbortError') throw error
    throw adapterFailure(`llama.cpp request failed: ${String(error?.message ?? error)}`, 'TRANSPORT')
  } finally {
    if (headerTimer !== null) clearTimeout(headerTimer)
  }
  if (!res.ok || res.body === null) {
    let detail = ''
    try {
      detail = (await readResponseText(res, streamIdleMs)).slice(0, 400)
    } catch (error) {
      progress.delete(key)
      // The idle ceiling is a classified TIMEOUT and must not be replaced by a
      // generic HTTP status. Other body-read failures fall back to the status.
      if (error?.failure !== undefined) throw error
    }
    progress.delete(key)
    // llama.cpp answers a refused request with the same `{"error": {...}}`
    // envelope it uses mid-stream, so read the reason out of it.
    let reason = detail
    try { reason = serverFailure(JSON.parse(detail)) ?? detail } catch { /* not JSON */ }
    throw adapterFailure(`llama.cpp refused the request (HTTP ${res.status}): ${reason}`,
      classifyDetail(reason) ?? codeForStatus(res.status))
  }

  let index = -1
  let open = null
  // Tool calls are parallel streams keyed by the provider's `index`; several
  // may be open at once. Keeping them here, rather than closing on every switch,
  // is what lets interleaved fragments reach the right block. The harness
  // assembler tolerates out-of-order block ends and orders blocks by first
  // appearance, so close them together at the end.
  const toolBlocks = new Map()
  let lastTool = null
  function* closeStreamBlocks() {
    const pending = [...toolBlocks.values()]
    if (open !== null) pending.push(open)
    pending.sort((left, right) => left.index - right.index)
    for (const block of pending) yield closeBlock(block)
    open = null
    toolBlocks.clear()
    lastTool = null
  }
  let finishReason = null
  let usageChunk = null
  // How this request ends: the row it leaves behind says so while the host holds it.
  let outcome = 'done'
  // Completion evidence: llama.cpp ends a good stream with a finish reason and
  // `data: [DONE]`, and a failed one by simply closing it.
  let sawDone = false
  let sawFrame = false
  let snippet = ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // An abort must stop the body promptly, even if the runtime's fetch does not
  // react to the signal on its own (pi-ai does the same).
  const onAbort = () => { void reader.cancel().catch(() => {}) }
  if (options.signal !== undefined) options.signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const { value, done } = await readWithIdle(reader, streamIdleMs)
      // Cancelling on abort resolves the pending read as `done` rather than
      // rejecting, so the signal is checked here: an abort is a clean
      // cancellation, never a stream that broke.
      if (options.signal !== undefined && options.signal.aborted) {
        const stopped = new Error('the request was aborted')
        stopped.name = 'AbortError'
        throw stopped
      }
      if (value != null) {
        const text = decoder.decode(value, { stream: true })
        // Kept only for a body that turns out not to be SSE at all.
        if (snippet.length < SNIPPET_MAX) snippet = (snippet + text).slice(0, SNIPPET_MAX)
        buffer += text
      }
      // EOF terminates the residual frame exactly as a blank line would, so a
      // final usage / timings / [DONE] frame is never left unparsed.
      if (done) {
        buffer += decoder.decode()
        if (buffer.trim() !== '') buffer += '\n\n'
      }
      const { payloads, rest } = takeSsePayloads(buffer)
      buffer = rest
      for (const payload of payloads) {
        if (payload === '[DONE]') { sawDone = true; continue }
        let chunk
        try { chunk = JSON.parse(payload) } catch {
          // A truncated frame can be glued to a following error frame. The
          // stream must still fail, but keep the provider's reason when it is
          // visible inside the malformed payload.
          const reason = /"error"\s*:\s*\{.*?"message"\s*:\s*"([^"]*)"/.exec(payload)
          throw adapterFailure(`llama.cpp returned malformed server-sent event JSON${reason === null ? '' : `: ${reason[1]}`}`, 'LLAMA_CPP_ERROR')
        }
        if (typeof chunk !== 'object' || chunk === null) continue
        sawFrame = true

        // A failed request arrives INSIDE the 200 stream as
        // `data: {"error": {message, type}}` (`format_error` in llama.cpp), then
        // the server closes the connection with no finish reason and no `[DONE]`.
        // Dropping that frame would make an OOM look like a normal empty stop.
        const failure = serverFailure(chunk)
        if (failure !== null) {
          // A mid-stream failure arrives after a 200, so there is no status to read:
          // overflow and quota are recognised by wording, everything else (OOM, a
          // killed slot) is a SERVER failure and retryable.
          throw adapterFailure(`llama.cpp failed the request: ${failure}`, classifyDetail(failure) ?? 'SERVER')
        }

        // Timings first: llama.cpp attaches `timings` to the SAME delta as
        // `prompt_progress` when `timings_per_token` is on, so handling this
        // branch after the progress branch (which `continue`s) discarded the
        // server's own prompt rate for the whole prompt phase.
        const timings = chunk.timings
        if (typeof timings === 'object' && timings !== null) {
          // Cumulative for THIS request, so the Live table can show how much it
          // has generated without borrowing a slot's counter.
          if (typeof timings.predicted_n === 'number') entry.decoded = timings.predicted_n
          if (typeof timings.predicted_n === 'number' && typeof timings.predicted_ms === 'number') {
            const rate = decodeWindowRate(windows.decode, timings.predicted_n, timings.predicted_ms)
            if (rate !== undefined) entry.decodeTps = rate
            // Until the window has 400 ms of generation to divide by, fall back to
            // the server's cumulative figure so the pill is never blank.
            else if (entry.decodeTps === null && typeof timings.predicted_per_second === 'number' && timings.predicted_per_second > 0) {
              entry.decodeTps = timings.predicted_per_second
            }
          } else if (typeof timings.predicted_per_second === 'number' && timings.predicted_per_second > 0) {
            entry.decodeTps = timings.predicted_per_second
          }
          if (typeof timings.prompt_per_second === 'number' && timings.prompt_per_second > 0) entry.promptTps = timings.prompt_per_second
          entry.updatedAt = Date.now()
        }
        const pp = chunk.prompt_progress
        if (typeof pp === 'object' && pp !== null) {
          if (typeof pp.total === 'number') entry.total = pp.total
          if (typeof pp.cache === 'number') entry.cache = pp.cache
          if (typeof pp.processed === 'number') entry.processed = pp.processed
          if (typeof pp.time_ms === 'number') entry.timeMs = pp.time_ms
          if (typeof entry.processed === 'number' && typeof entry.timeMs === 'number') {
            const cache = typeof entry.cache === 'number' ? entry.cache : 0
            const rate = promptWindowRate(windows.prompt, entry.processed - cache, entry.timeMs)
            // undefined means this pair cannot support a rate; keep the last one.
            if (rate !== undefined) entry.promptTps = rate
          }
          entry.phase = 'prompt'
          entry.updatedAt = Date.now()
          continue
        }
        // The hot path: a delta frame rarely carries usage, so skip the call.
        if (chunk.usage !== undefined) usageChunk = mapUsage(chunk.usage) ?? usageChunk
        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
        if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') finishReason = choice.finish_reason
        const delta = typeof choice?.delta === 'object' && choice?.delta !== null ? choice.delta : null
        if (delta === null) continue
        const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
        const contentText = typeof delta.content === 'string' ? delta.content : ''
        const reasoningText = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
        // A delta may carry reasoning and content together (proxies and some
        // builds do); emit both instead of choosing one and dropping the other.
        if (reasoningText !== '') {
          if (open !== null && open.kind !== 'reasoning') { yield closeBlock(open); open = null }
          if (open === null) {
            index += 1
            open = { index, kind: 'reasoning', text: '' }
            yield { type: 'block-start', index, blockType: 'reasoning' }
          }
          open.text += reasoningText
          yield { type: 'reasoning-delta', index: open.index, text: reasoningText }
          entry.phase = 'decode'
        }
        // Content and tool calls are separate block kinds. A text/reasoning
        // block ends when tools start; open tool blocks stay open so their
        // interleaved fragments can continue arriving.
        if (toolCalls.length > 0) {
          if (open !== null) { yield closeBlock(open); open = null }
          for (const call of toolCalls) {
            const toolIndex = typeof call?.index === 'number' ? call.index : undefined
            const id = typeof call?.id === 'string' && call.id !== '' ? call.id : undefined
            const name = typeof call?.function?.name === 'string' ? call.function.name : ''
            let block = toolIndex !== undefined ? toolBlocks.get(`i:${toolIndex}`) : undefined
            if (block === undefined && id !== undefined) {
              for (const candidate of toolBlocks.values()) {
                if (candidate.id === id) { block = candidate; break }
              }
            }
            if (block === undefined && toolIndex === undefined && id === undefined) block = lastTool
            if (block === undefined) {
              index += 1
              block = { index, kind: 'tool', id: id ?? `call-${index}`, name, args: '' }
              toolBlocks.set(toolIndex !== undefined ? `i:${toolIndex}` : `n:${index}`, block)
              yield { type: 'block-start', index, blockType: 'tool-call' }
            }
            if (toolIndex !== undefined && !toolBlocks.has(`i:${toolIndex}`)) toolBlocks.set(`i:${toolIndex}`, block)
            if (id !== undefined && block.id !== id) block.id = id
            if (block.name === '' && name !== '') block.name = name
            const fragment = typeof call?.function?.arguments === 'string' ? call.function.arguments : ''
            block.args += fragment
            lastTool = block
            yield { type: 'tool-call-delta', index: block.index, id: block.id, ...(block.name === '' ? {} : { name: block.name }), argumentsDelta: fragment }
          }
          entry.phase = 'decode'
        }
        if (contentText !== '') {
          if (open !== null && open.kind !== 'text') { yield closeBlock(open); open = null }
          if (open === null) {
            index += 1
            open = { index, kind: 'text', text: '' }
            yield { type: 'block-start', index, blockType: 'text' }
          }
          open.text += contentText
          yield { type: 'text-delta', index: open.index, text: contentText }
          entry.phase = 'decode'
        }
      }
      if (done) break
    }
    // A stream that ends without a finish reason and without `[DONE]` was cut
    // off: a killed server, a dropped connection, or an error frame this build
    // did not send. Reporting `stop` here is what hid the failure from the user.
    if (finishReason === null && !sawDone) {
      if (sawFrame) {
        // Frames arrived and then the stream closed with no finish reason and no
        // `[DONE]`: pi-ai calls this STREAM_CLOSED (terminal — a transport error
        // that THREW is the retryable case, see the catch below).
        throw adapterFailure('llama.cpp ended the stream without a finish reason', 'STREAM_CLOSED')
      }
      throw adapterFailure(`llama.cpp returned no stream at all${snippet.trim() === '' ? '' : `: ${snippet.trim()}`}`, 'STREAM_CLOSED')
    }
    // `[DONE]` is not a finish reason. pi-ai requires the provider's terminal
    // finish_reason and classifies a stream that ends without one as TRANSPORT,
    // even when a DONE marker arrived; accepting it would turn a broken turn
    // into a normal empty stop.
    if (finishReason === null) throw adapterFailure('llama.cpp ended the stream without a finish reason', 'TRANSPORT')
    for (const chunk of closeStreamBlocks()) yield chunk
    if (usageChunk !== null) yield usageChunk
    if (index < 0 && finishReason === 'stop') {
      // The harness's own convention for a completed response with no content
      // (pi-ai and the DeepSeek adapter do the same); its code is retryable, so
      // a transient empty turn is retried and a persistent one is surfaced.
      throw adapterFailure(`llama.cpp model "${options.model}" returned a completed response with no content`, 'EMPTY_RESPONSE')
    }
    if (finishReason === 'length') yield { type: 'finish', reason: { kind: 'max-tokens' } }
    else if (finishReason === 'tool_calls' || finishReason === 'tool-calls' || finishReason === 'function_call') {
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else if (finishReason === 'stop' || finishReason === 'end') yield { type: 'finish', reason: { kind: 'stop' } }
    else throw adapterFailure(`llama.cpp finish_reason: ${finishReason}`, 'LLAMA_CPP_ERROR')
  } catch (error) {
    if (error?.name === 'AbortError') {
      outcome = 'aborted'
      for (const chunk of closeStreamBlocks()) yield chunk
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: String(error?.message ?? error), code: 'ABORTED' } } }
      return
    }
    outcome = 'failed'
    // A failure this adapter already classified (EMPTY_RESPONSE, SERVER, TIMEOUT,
    // STREAM_CLOSED…) must keep its code: only a bare transport error thrown by the
    // socket needs a taxonomy of its own here.
    if (error?.failure !== undefined) throw error
    throw adapterFailure(`llama.cpp stream failed: ${String(error?.message ?? error)}`,
      classifyDetail(String(error?.message ?? error)) ?? 'TRANSPORT')
  } finally {
    if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
    // Held, not deleted: the entry keeps the row alive while the task moves on to
    // its next turn, and `liveProgress` drops it HOLD_MS after this moment.
    rateWindows.delete(key)
    entry.endedAt = Date.now()
    entry.outcome = outcome
    // `cancel` also drops the lock; `releaseLock` alone throws while a read is
    // pending and leaves the socket draining when a consumer stops early.
    void reader.cancel().catch(() => {})
  }
}

/**
 * Live model catalog of one llama.cpp origin.
 *
 * `/v1/models` supplies the served ids and their metadata; `/props` supplies the
 * server's own alias, per-slot context, default output cap, modalities, and
 * reasoning vocabulary. They are read together because either one alone leaves
 * the picker incomplete: a server that does not list models still reports its
 * alias, and a server that lists models still owns the context number.
 *
 * A failed fetch is cached too, with a shorter TTL: an unreachable origin is
 * asked on every model resolution otherwise (`resolveModel` runs on every
 * request), which costs three timed-out upstream requests per call for as long
 * as the server is down.
 *
 * @param origin - llama.cpp endpoint origin.
 * @param auth - authorization headers for this operation.
 * @returns `{ models, contextWindow, defaultMaxTokens, contextSource }`.
 */
async function catalogFor(origin, auth = {}) {
  const hit = catalogs.get(origin)
  if (hit !== undefined && Date.now() - hit.at < hit.ttlMs) return hit
  contextTrace = { at: Date.now(), provider: null, model: null, contextWindow: null, source: 'fetching' }
  const [body, caps] = await Promise.all([
    fetchJson(`${origin}/v1/models`, CATALOG_TIMEOUT_MS, auth),
    fetchJson(`${origin}/props`, CATALOG_TIMEOUT_MS, auth),
  ])
  const props = normalizeProps(caps)
  // llama.cpp treats this exact string as an image placeholder anywhere in the
  // rendered prompt. It is normally only injected from an `image_url` part, but
  // a tool result that echoes `/props` carries it as plain text; keeping it here
  // lets `llamaStream` defuse it before the next request is tokenized.
  const mediaMarker = typeof caps?.media_marker === 'string' && caps.media_marker !== '' ? caps.media_marker : null
  const rows = Array.isArray(body?.data) && body.data.length > 0 ? body.data : Array.isArray(body?.models) ? body.models : []
  const models = []
  // `/props` reports the context the server actually loaded; `/v1/models`
  // `meta.n_ctx` is the model's training context and can be larger than the
  // server's `-c`. Prefer the loaded number, and keep meta as the fallback for
  // builds that omit `default_generation_settings.n_ctx`.
  let contextWindow = typeof props?.nCtx === 'number' && props.nCtx > 0 ? props.nCtx : null
  let contextSource = contextWindow === null ? null : 'props'
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id : typeof row?.model === 'string' ? row.model : ''
    if (id === '') continue
    const name = typeof row?.name === 'string' && row.name !== '' ? row.name : id
    const input = []
    const declared = Array.isArray(row?.architecture?.input_modalities) ? row.architecture.input_modalities : null
    if (declared !== null) {
      if (declared.includes('text')) input.push('text')
      if (declared.includes('image')) input.push('image')
    } else if (Array.isArray(row?.capabilities) && row.capabilities.includes('multimodal')) {
      input.push('text', 'image')
    }
    // Older llama.cpp builds and minimal OpenAI-compatible proxies can omit the
    // architecture block. /props still knows whether the loaded model accepts
    // images; apply that answer to the served row rather than advertising
    // text-only.
    if (input.length === 0 && Array.isArray(props?.inputModalities)) {
      const served = typeof props?.model === 'string' ? props.model : null
      if (rows.length === 1 || id === served || name === served) input.push(...props.inputModalities)
    }
    if (input.length === 0) input.push('text')
    if (contextWindow === null && typeof row?.meta?.n_ctx === 'number' && row.meta.n_ctx > 0) {
      contextWindow = row.meta.n_ctx
      contextSource = 'catalog'
    }
    models.push({ id, name, input })
  }
  // The server's alias is the model this build is actually serving; it is the
  // only model fact available when `/v1/models` is absent or empty.
  if (models.length === 0 && typeof props?.model === 'string' && props.model !== '') {
    models.push({ id: props.model, name: props.model, input: props.inputModalities ?? ['text'] })
  }
  if (contextWindow !== null) probedContextWindows.set(origin, contextWindow)
  if (contextWindow === null) {
    const slots = await fetchJson(`${origin}/slots`, CATALOG_TIMEOUT_MS, auth)
    for (const slot of Array.isArray(slots) ? slots : []) {
      if (typeof slot?.n_ctx === 'number' && slot.n_ctx > 0) {
        contextWindow = slot.n_ctx
        contextSource = 'catalog'
        break
      }
    }
  }
  // Learn the server's reasoning choices on the same cadence as the catalog.
  // A template that accepts reasoning_effort but does not enumerate values gets
  // the standard fallback; an explicit probe failure keeps the last known list.
  if (caps !== null) {
    const readsEffort = caps?.chat_template_caps?.supports_reasoning_effort === true
    if (readsEffort) {
      const found = await probeEfforts(origin, auth)
      if (found !== null) {
        effortCatalog.set(origin, {
          mode: 'server',
          levels: found.levels,
          defaultLevel: found.defaultLevel,
          offValue: found.offValue,
        })
      } else if (!effortCatalog.has(origin)) {
        effortCatalog.set(origin, standardEffortCatalog())
      }
    } else {
      const template = typeof caps?.chat_template === 'string' ? caps.chat_template : ''
      effortCatalog.set(origin, {
        mode: template.includes('enable_thinking') ? 'thinking' : 'none',
        levels: new Set(),
        defaultLevel: null,
        offValue: 'none',
      })
    }
  } else if (!effortCatalog.has(origin)) {
    effortCatalog.set(origin, standardEffortCatalog())
  }
  const effort = effortCatalog.get(origin)
  let systemRole = typeof hit?.systemRole === 'boolean' ? hit.systemRole : true
  if (typeof caps?.chat_template === 'string' && caps.chat_template !== '') {
    const probed = await probeSystemRole(origin, auth)
    if (probed !== null) systemRole = probed
  }
  effortTrace = {
    at: Date.now(),
    origin,
    supportsReasoningEffort: caps === null ? null : caps?.chat_template_caps?.supports_reasoning_effort === true,
    mode: effort?.mode ?? null,
    levels: effort === undefined ? null : [...effort.levels],
    defaultLevel: effort?.defaultLevel ?? null,
    offValue: effort?.offValue ?? null,
  }
  const defaultMaxTokens = typeof props?.defaultMaxTokens === 'number' && props.defaultMaxTokens > 0 ? props.defaultMaxTokens : null
  const totalSlots = typeof props?.totalSlots === 'number' && props.totalSlots > 0 ? props.totalSlots : null
  const live = models.length > 0 || contextWindow !== null || defaultMaxTokens !== null
  const catalog = {
    at: Date.now(),
    ttlMs: live ? CATALOG_TTL_MS : CATALOG_FAIL_TTL_MS,
    models,
    contextWindow,
    contextSource,
    defaultMaxTokens,
    totalSlots,
    systemRole,
    ...(mediaMarker === null ? {} : { mediaMarker }),
  }
  catalogs.set(origin, catalog)
  return catalog
}

/** Duck-typed LlmAdapter serving every declared llama.cpp route. */
function createLlamaAdapter(ctx) {
  const info = (route, model) => ({
    provider: route,
    id: model.id,
    name: model.name,
    inputModalities: model.input,
    systemPromptUpdate: 'in-history',
  })
  // `INVALID_REQUEST`, not a bare Error: a caller asking this adapter for a route it
  // does not serve is a request error, and a bare Error would surface as UNKNOWN.
  const declaredRoutes = () => [...servers.keys()].sort().join(', ')
  // Naming the declared routes matters: a typo in a session's provider is the only
  // way to reach this, and the answer should say what was available.
  const unknown = (provider) => adapterFailure(`"${provider}" is not a declared llama.cpp route (have: ${declaredRoutes()})`, 'INVALID_REQUEST')
  /**
   * The one descriptor for one route+model. `resolveModel`,
   * `prepareCall`, and therefore the model picker and the request validator all
   * return exactly this, because a difference between them is a defect: the
   * picker persists `reasoning.defaultEffort`, and the request path validates
   * that same effort against whatever `prepareCall` returned.
   */
  const describe = async (provider, model) => {
    const entry = servers.get(provider)
    if (entry === undefined) throw unknown(provider)
    const auth = await routeHeaders(ctx, entry)
    const catalog = await catalogFor(entry.origin, auth)
    const known = catalog.models.find(m => m.id === model) ?? { id: model, name: model, input: ['text'] }
    // The catalog already merges `/v1/models` and `/props`; the per-origin probe
    // is a last resort for an older reading. No configured fallback: an unknown
    // window is omitted rather than invented.
    const probed = catalog.contextWindow === null ? probedContextWindows.get(entry.origin) ?? null : null
    const contextWindow = catalog.contextWindow ?? probed
    const source = catalog.contextWindow !== null ? catalog.contextSource ?? 'catalog' : probed !== null ? 'props' : 'unknown'
    contextTrace = {
      at: Date.now(),
      provider: entry.provider,
      model,
      contextWindow,
      source,
    }
    const reasoning = reasoningInfo(entry.origin)
    return {
      ...info(provider, known),
      ...(contextWindow === null ? {} : { context: { contextWindow } }),
      ...(catalog.defaultMaxTokens === null ? {} : { defaultMaxTokens: catalog.defaultMaxTokens }),
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }

  /**
   * `prepareCall` must describe the model with `describe()`, never with a bare
   * `{provider, id, name}`: the picker persists `reasoning.defaultEffort` from
   * `resolveModel`, and the request path validates that effort and the context
   * window against what `prepareCall` returns. Both must use one descriptor.
   */
  return {
    providerInfo: (provider) => ({ id: provider, name: displayNameFor(servers.get(provider)?.alias ?? provider) }),
    // No provider-specific retry policy: the runtime's normal defaults are the
    // same policy pi-ai resolves for a llama.cpp profile with no retryPolicy.
    providerRetryPolicy: () => undefined,
    // llama.cpp includes image chunks in the total prompt_tokens but exposes no
    // per-image visual-token count, so priceImages() cannot answer exactly
    // before the request. Leave pricing undefined; the token meter uses its
    // fixed image heuristic until provider usage (which includes image tokens)
    // anchors a completed request.
    imageRequestPricing: () => undefined,
    // A duck-typed adapter does not inherit `LlmAdapter`'s base default, so the
    // identity target is stated explicitly. Returning `undefined` here would
    // break the documented contract (the return is not optional) and any
    // consumer resolving this route's request image: llama.cpp keeps the
    // normalized image as-is, so the default must be preserved.
    imageRequestTarget: (_provider, _model, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    listModels: async (provider) => {
      // Same guard as `describe`: this adapter answers only for declared routes.
      const entry = servers.get(provider)
      if (entry === undefined) throw unknown(provider)
      const auth = await routeHeaders(ctx, entry)
      return (await catalogFor(entry.origin, auth)).models.map(model => info(provider, model))
    },
    resolveModel: describe,
    prepareCall: async (provider, model) => ({
      model: await describe(provider, model),
      stream: (options) => llamaStream(ctx, options),
    }),
    stream: (options) => llamaStream(ctx, options),
  }
}

function clamped(value, min, max, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), min), max) : fallback
}

// `webServer` is deliberately absent: the headless bundle mounts no HTTP server,
// and the adapter must still serve llama.cpp routes there. The metrics endpoints
// are registered through a nested optional injection below.
export const inject = ['llm', 'attachments']

/**
 * The `/llamacpp-metrics/live` handler.
 *
 * Two payloads, one route:
 * - **light** (default): the pill's data — the cached verdict plus this
 *   session's SSE progress — and **no upstream request at all**.
 * - **readings** (`live=1`): additionally reads `/metrics` and `/slots` and
 *   carries them for the dialog. The client sends this only while its dialog is
 *   open, so a closed dialog costs the llama.cpp server nothing.
 *
 * Every request is still the consequence of one client poll; nothing here runs
 * on a timer.
 *
 * @param ctx - host context with `llm`, `configEditor`, `settings`.
 * @param options - resolved plugin config: `pollMs`, and the catalog-refresh hook.
 * @returns a web-server handler.
 */
function createLiveHandler(ctx, { pollMs, onAvailabilityChange }) {
  return async function handler(req, res) {
    if (req.method !== 'GET') return json(res, 404, { error: 'not-found' })
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      return json(res, 400, { error: 'bad-url' })
    }
    const provider = url.searchParams.get('provider') ?? ''
    const model = url.searchParams.get('model') ?? ''
    const retry = url.searchParams.get('retry') === '1'
    // Only the dialog needs `/metrics` and `/slots`; the pill runs on SSE
    // progress and the cached verdict.
    const readings = url.searchParams.get('live') === '1'
    if (provider === '') return json(res, 400, { error: 'missing-provider' })

    // The endpoint is config, not a scan: look the declared route up and probe it.
    const route = servers.get(provider)
    if (route === undefined) {
      return json(res, 200, { provider, state: 'unknown', online: false, updatedAt: Date.now() })
    }
    const origin = route.origin
    let auth
    try {
      auth = await routeHeaders(ctx, route)
    } catch (error) {
      return json(res, 200, {
        provider,
        state: 'unauthorized',
        online: false,
        credential: 'missing',
        credentialRef: route.apiKeyEnv,
        message: String(error?.message ?? error),
        pollMs,
        updatedAt: Date.now(),
      })
    }

    // One verdict per ORIGIN: `/props` describes the server, not the model the
    // client asked about, so keying it by provider made two sessions on one
    // server with different model ids re-probe on every poll.
    let verdict = verdicts.get(origin)
    // Probe only at initialization or on a page reload (`retry=1` from the
    // client's first poll) — never on a timer.
    if (retry || verdict === undefined) {
      const previous = verdict
      verdict = { ...(await probeOrigin(origin, auth)), at: Date.now() }
      verdicts.set(origin, verdict)
      const wasOnline = previous?.state === 'llama'
      const isOnline = verdict.state === 'llama'
      const cached = catalogs.get(origin)
      // An empty cached catalog means the model picker saw this server as
      // unavailable. Retry it while the server is up, even without a state
      // transition, so a slow `/v1/models` does not leave the picker empty.
      const emptyCatalog = isOnline && cached !== undefined && cached.models.length === 0
      if ((previous !== undefined && wasOnline !== isOnline) || emptyCatalog) {
        catalogs.delete(origin)
        try {
          onAvailabilityChange?.(origin, verdict.state)
        } catch (error) {
          ctx.logger?.warn?.(`dsh-llm-llamacpp: availability refresh failed; ${String(error?.message ?? error)}`)
        }
      }
    }

    const base = {
      provider,
      state: verdict.state,
      online: verdict.state === 'llama',
      metricsEnabled: verdict.metricsEnabled,
      servedModel: verdict.props?.model ?? null,
      servedModelMatches: null,
      props: verdict.props ?? null,
      // Whether this payload carries server readings; the dialog's raw sections
      // wait for a true one rather than showing an empty reading.
      live: readings,
      // The client's poll interval. Every payload carries it, including one
      // with no readings — otherwise a closed dialog would fall back to its
      // own slow default and the pill would lag.
      pollMs,
      updatedAt: Date.now(),
    }
    if (verdict.state !== 'llama') return json(res, 200, withMatch(base, model))

    // Both payloads carry the in-flight requests; name their tasks first.
    labelProgress(ctx)

    if (!readings) {
      // The pill's payload: no /metrics, no /slots, no upstream traffic.
      return json(res, 200, withMatch({
        ...base,
        progressLive: liveProgress(),
        debug: { contextTrace, effortTrace, request: requestTrace },
      }, model))
    }

    // The dialog is open: read the server on demand, never on a timer. Concurrent
    // polls share one in-flight request, and a closed dialog makes no request.
    try {
      let pending = inflight.get(origin)
      if (pending === undefined) {
        pending = liveSnapshot(origin, verdict, auth)
        inflight.set(origin, pending)
        pending.catch(() => {}).finally(() => inflight.delete(origin))
      }
      const body = await pending
      if (body === null) {
        // Reachability blip on a confirmed llama endpoint: the verdict stands,
        // this response reports offline, and the next client poll reads live
        // again — no re-probe and no extra traffic in between.
        const last = lastLiveAt.get(origin)
        return json(res, 200, withMatch({ ...base, online: false, ...(last === undefined ? {} : { lastSeenAt: last }) }, model))
      }
      return json(res, 200, withMatch({ ...base, online: true, ...body }, model))
    } catch {
      return json(res, 200, withMatch({ ...base, online: false }, model))
    }
  }
}

/** The marker `@deepseek-ai/cosmokit` writes on a live (volatile) config value. */
const VOLATILE = Symbol.for('cosmokit.volatile.write')

/**
 * The current value behind one config field, volatile or not.
 *
 * A volatile field arrives as a reference (`{ get() }`) rather than a snapshot so a
 * committed write can update it in place; every reader goes through this instead of
 * assuming a plain object. The marker is looked up by its registered symbol, so a
 * copy of the library loaded elsewhere is still recognized.
 *
 * @param value - a config value, possibly volatile.
 * @returns the value it currently holds.
 */
function unwrapConfig(value) {
  return value !== null && typeof value === 'object' && VOLATILE in value ? value.get() : value
}

/**
 * The plugin config schema.
 *
 * `servers` is **volatile**, and that is what puts these routes in Settings → Models.
 * `dsh-settings` publishes a plugin's namespace only when its `Config` declares at
 * least one volatile field (`describe()` drops an entry whose form has none),
 * refuses a write to any path that is not under a volatile node, and commits a
 * volatile change in place — so a write from the page re-points the routes without
 * re-applying the plugin. The other fields stay ordinary: changing one still
 * re-applies the plugin, which is fine because none has to survive a running
 * request.
 *
 * A server profile names only what the user owns: an optional alias, the endpoint,
 * and an optional credential reference. The served model, context window, and
 * output cap belong to llama.cpp and are read from it.
 *
 * `apiKeyEnv` is the credential reference the page's key field stores under; no
 * secret is ever written into this config.
 */
export const Config = z.object({
  servers: z.dict(z.object({
    alias: z.string(),
    baseURL: z.string(),
    apiKeyEnv: z.string().role('credential-ref'),
  })).volatile(),
  clientPollMs: z.number(),
  streamIdleTimeoutMs: z.number(),
})

/** The prefix of the route id the Models page's add-provider row is created under. */
const SUGGESTED_ROUTE = 'llamacpp'

/**
 * The first route id no declared server uses: `llamacpp`, then `llamacpp-2`, …
 *
 * The Models page's add list can only create a server at a path a directory entry
 * already names, so this is the id a NEW server is offered under. Deriving it from
 * every declared route (including one that currently fails validation) keeps one
 * dormant row available without colliding with an error row.
 *
 * @param taken - route ids already declared.
 * @returns a free route id.
 */
function nextFreeRoute(taken) {
  if (!taken.has(SUGGESTED_ROUTE)) return SUGGESTED_ROUTE
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${SUGGESTED_ROUTE}-${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `${SUGGESTED_ROUTE}-${Date.now()}`
}

/**
 * The endpoint a NEW server starts at: llama-server's own default port, which
 * upstream moved from 8080 to 9931 in llama.cpp `b42b7e6d3` (PR #30159).
 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:9931/v1'

/**
 * The configurable-provider directory entries this plugin owns.
 *
 * One row per declared route, addressed at `servers.<route>` inside this plugin's
 * own settings namespace, plus one **dormant** row at the first free
 * `llamacpp`-prefixed id: the Models page only offers rows the directory already
 * declares, so that row is how "Add model provider" creates a server — the first
 * one and every later one. A declared route that failed validation still gets a
 * row, carrying `error`, so the page can show the problem instead of hiding it.
 *
 * @param map - the resolvable routes.
 * @param settingsNs - this plugin's settings namespace (the profile row id).
 * @param options - `{ errors, declared }` for broken/declared rows; defaults to the
 *   map's own routes.
 * @returns the entries, configured routes first.
 */
export function directoryEntriesFor(map, settingsNs, options = {}) {
  const errors = options.errors instanceof Map ? options.errors : new Map()
  const declared = Array.isArray(options.declared)
    ? options.declared
    : [...map.keys()].map((provider) => ({ provider }))
  const entries = []
  const taken = new Set(declared.map((item) => item.provider))
  for (const item of declared) {
    const entry = map.get(item.provider)
    if (entry !== undefined) {
      entries.push({
        provider: entry.provider,
        displayName: displayNameFor(entry.alias),
        settingsNs,
        settingsPath: ['servers', entry.provider],
        declared: true,
        defaultBaseURL: entry.baseURL,
      })
      continue
    }
    entries.push({
      provider: item.provider,
      displayName: displayNameFor(bareAlias(item.alias) || item.provider),
      settingsNs,
      settingsPath: ['servers', item.provider],
      declared: true,
      error: errors.get(item.provider) ?? `llama.cpp route "${item.provider}" is not serviceable`,
    })
  }
  const reserved = nextFreeRoute(taken)
  entries.push({
    provider: reserved,
    displayName: 'llama.cpp (new server)',
    settingsNs,
    settingsPath: ['servers', reserved],
    declared: true,
    defaultBaseURL: DEFAULT_BASE_URL,
  })
  return entries
}

/**
 * What the Models page can see of this plugin, as the host's own answer.
 *
 * The page's add list only offers a family whose settings namespace the settings
 * mirror published, and that mirror hides every entry whose `Config` declares no
 * volatile field — so "is our row offerable at all?" is a host fact, not a UI one.
 * Reported on `/llamacpp-metrics/config` so a row that never appears can be
 * diagnosed from the payload instead of guessed at.
 *
 * @param settings - the settings service, or null when the host has none.
 * @param settingsNs - this plugin's namespace.
 * @returns whether the mirror published it, and the servers it reads back.
 */
function settingsSelfReport(ctx, settings, settingsNs) {
  if (settings === null || settings === undefined) return { visible: null, servers: null, directory: null }
  try {
    const view = settings.describe({ redactSecrets: true }).find((row) => row.ns === settingsNs)
    const published = typeof ctx?.llm?.listConfigurableProviders === 'function'
      ? ctx.llm.listConfigurableProviders().filter((entry) => entry.settingsNs === settingsNs).map((entry) => entry.provider)
      : null
    if (view === undefined) return { visible: false, servers: [], directory: published }
    const map = view.value !== null && typeof view.value === 'object' ? view.value.servers : undefined
    return {
      visible: true,
      servers: map !== null && typeof map === 'object' ? Object.keys(map) : [],
      directory: published,
    }
  } catch (error) {
    return { visible: null, servers: null, directory: null, error: String(error?.message ?? error) }
  }
}

/** Longest a draft interrogation waits for its endpoint. */
const DISCOVERY_TIMEOUT_MS = 8000

/**
 * Interrogate one llama.cpp endpoint for the models it serves.
 *
 * The draft carries the endpoint and a one-shot key; when it names an existing
 * route, the stored endpoint and credential fill in what the draft leaves out.
 * Nothing is stored: a plain `Error` is the contract, and the harness surfaces its
 * message as the refusal the card renders. `/props` is read alongside
 * `/v1/models` because it supplies the alias, context, and modalities when the
 * model list is absent or empty.
 *
 * @param ctx - host context, for the stored route's credential.
 * @param request - `{ provider?, baseURL?, apiKey? }` as the page shows it.
 * @param signal - caller cancellation.
 * @returns discovered models, in the server's own order.
 */
export async function discoverLlamaModels(ctx, request, signal) {
  const stored = typeof request?.provider === 'string' ? servers.get(request.provider) : undefined
  const rawBaseURL = typeof request?.baseURL === 'string' && request.baseURL.trim() !== '' ? request.baseURL : stored?.baseURL
  const baseURL = parseBaseURL(rawBaseURL)
  if (baseURL === null) throw new Error(`dsh-llm-llamacpp: model discovery needs a full http(s) baseURL including its path (got "${String(rawBaseURL ?? '')}")`)
  const origin = originOf(baseURL)
  let apiKey = typeof request?.apiKey === 'string' && request.apiKey !== '' ? request.apiKey : null
  if (apiKey === null && stored !== undefined) apiKey = await credentialValue(ctx, stored)
  const headers = { accept: 'application/json', ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }) }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
  const abort = () => controller.abort()
  signal?.addEventListener?.('abort', abort, { once: true })
  const get = async (url) => {
    try {
      const res = await fetch(url, { signal: controller.signal, headers })
      return { status: res.status, body: res.ok ? await res.json().catch(() => null) : null }
    } catch {
      return { status: 0 }
    }
  }
  try {
    const [list, caps] = await Promise.all([get(`${baseURL}/models`), get(`${origin}/props`)])
    if (list.status === 401 || list.status === 403 || caps.status === 401 || caps.status === 403) {
      throw new Error(`dsh-llm-llamacpp: ${origin} rejected the credential${apiKey === null ? ' (none was supplied)' : ''}`)
    }
    if (list.status === 0 && caps.status === 0) {
      throw new Error(`dsh-llm-llamacpp: ${origin} did not answer within ${DISCOVERY_TIMEOUT_MS / 1000} s`)
    }
    const props = normalizeProps(caps.body)
    const rows = Array.isArray(list.body?.data) ? list.body.data : Array.isArray(list.body?.models) ? list.body.models : []
    let contextWindow = typeof props?.nCtx === 'number' && props.nCtx > 0 ? props.nCtx : null
    const models = []
    const seen = new Set()
    for (const row of rows) {
      const id = typeof row?.id === 'string' ? row.id : typeof row?.model === 'string' ? row.model : ''
      if (id === '' || seen.has(id)) continue
      const input = Array.isArray(row?.architecture?.input_modalities)
        ? row.architecture.input_modalities.filter((value) => value === 'text' || value === 'image')
        : null
      if (contextWindow === null && typeof row?.meta?.n_ctx === 'number' && row.meta.n_ctx > 0) contextWindow = row.meta.n_ctx
      seen.add(id)
      models.push({
        id,
        ...(typeof row?.name === 'string' && row.name !== '' ? { name: row.name } : {}),
        ...(contextWindow === null ? {} : { contextWindow }),
        ...(input === null || input.length === 0 ? {} : { inputModalities: input }),
      })
    }
    if (models.length === 0 && typeof props?.model === 'string' && props.model !== '') {
      models.push({
        id: props.model,
        name: props.model,
        ...(contextWindow === null ? {} : { contextWindow }),
        ...(props.inputModalities === undefined ? {} : { inputModalities: props.inputModalities }),
      })
    }
    if (contextWindow !== null) {
      for (const model of models) if (model.contextWindow === undefined) model.contextWindow = contextWindow
    }
    if (models.length === 0) {
      const status = list.status !== 0 ? `HTTP ${list.status}` : caps.status !== 0 ? `HTTP ${caps.status}` : 'no answer'
      throw new Error(`dsh-llm-llamacpp: ${origin} did not report any model (${status})`)
    }
    return models
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', abort)
  }
}

/**
 * Resolve the llama.cpp servers this plugin serves.
 *
 * `config.servers` is the only form: a map of `provider -> { alias, baseURL,
 * apiKeyEnv }`. Every entry is validated independently, so one broken endpoint
 * cannot hide the working ones; the returned `errors` and `declared` lists let the
 * Models page show a broken row instead of dropping it.
 *
 * Nothing here probes or guesses: a wrong `baseURL` is a row error, not a silently
 * missing route.
 *
 * @param config - the plugin row's config.
 * @returns `{ routes, errors, declared }`.
 */
export function resolveServerProfiles(config) {
  const declaredRaw = config?.servers
  const entries = declaredRaw !== null && typeof declaredRaw === 'object' && !Array.isArray(declaredRaw)
    ? Object.entries(declaredRaw)
    : []
  const routes = new Map()
  const errors = new Map()
  const declared = []
  for (const [rawName, raw] of entries) {
    const provider = typeof rawName === 'string' ? rawName.trim() : ''
    if (provider === '') {
      errors.set(rawName, 'dsh-llm-llamacpp: server routes need a non-empty id')
      continue
    }
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const aliasText = bareAlias(source.alias)
    const baseURL = parseBaseURL(source.baseURL)
    const origin = baseURL === null ? null : originOf(baseURL)
    const apiKeyEnvText = typeof source.apiKeyEnv === 'string' ? source.apiKeyEnv.trim() : ''
    const problems = []
    if (!ROUTE_ID_PATTERN.test(provider)) problems.push('the route id must be lowercase words separated by dashes (for example "llamacpp-lab")')
    if (baseURL === null) problems.push(`baseURL ${typeof source.baseURL === 'string' && source.baseURL.trim() !== '' ? `"${source.baseURL}" must be the full http(s) API URL including its path (for example http://127.0.0.1:9931/v1), without a query or hash` : 'is required, including its API path (for example http://127.0.0.1:9931/v1)'}`)
    if (apiKeyEnvText !== '' && !CREDENTIAL_REF_PATTERN.test(apiKeyEnvText)) problems.push(`apiKeyEnv "${apiKeyEnvText}" is not a valid credential reference`)
    if (problems.length > 0) {
      declared.push({ provider, alias: aliasText || provider })
      errors.set(provider, `dsh-llm-llamacpp: route "${provider}": ${problems.join('; ')}`)
      continue
    }
    const alias = aliasText !== '' ? aliasText : defaultAlias(origin, provider)
    declared.push({ provider, alias })
    routes.set(provider, { provider, alias, baseURL, origin, apiKeyEnv: apiKeyEnvText === '' ? null : apiKeyEnvText })
  }
  return { routes, errors, declared }
}

/**
 * Register the declared llama.cpp routes and the metrics endpoint.
 *
 * Routes come only from config: no interception, no rewriting, no timers. Every
 * upstream request follows a client poll or a config/credential invalidation.
 *
 * @param ctx - host context with `llm` and `attachments`; `webServer` is optional.
 * @param config - `{ servers, clientPollMs, streamIdleTimeoutMs }` from the patch row.
 * @returns cleanup disposing the routes, directory, endpoints and caches.
 */
export function apply(ctx, config) {
  const pollMs = clamped(config?.clientPollMs, 500, 60_000, 2500)
  // pi-ai's stream idle ceiling is a user setting there; the same default here.
  streamIdleMs = clamped(config?.streamIdleTimeoutMs, 0, 3_600_000, 300_000)
  // The namespace the Models page addresses this plugin by: the profile row id,
  // which is also the key the client's provider card is registered under.
  const settingsNs = ctx.fiber?.entry?.options?.id ?? 'dsh-llm-llamacpp'
  const resolveCurrent = () => resolveServerProfiles({ servers: unwrapConfig(config?.servers) })
  const adapter = createLlamaAdapter(ctx)
  /** The settings service, once injected; null in a host without one. */
  let settingsService = null
  /** The route set this registration currently holds, serialized. */
  let routeFacts
  /** The directory entries this registration currently holds, serialized. */
  let directoryFacts
  let adapterHandle = null
  let directoryHandle = null

  /**
   * Publish the current routes and directory, when either moved.
   *
   * Both handles are replaceable so an edit swaps the set in one synchronous
   * section, and an empty set is legal (a settings map the user emptied holds zero
   * routes while the registration stays). Nothing is published when the facts are
   * unchanged: every `replace` announces itself as `llm/adapters-updated`.
   */
  function publish() {
    const routes = [...servers.keys()]
    const facts = routes.join('\u0000')
    if (facts !== routeFacts) {
      if (adapterHandle === null) {
        if (routes.length > 0) adapterHandle = ctx.llm.registerAdapter(routes, adapter)
      } else {
        adapterHandle.replace(routes)
      }
      routeFacts = facts
    }
    const entries = directoryEntriesFor(servers, settingsNs, { errors: routeErrors, declared: declaredRoutes })
    const entryFacts = JSON.stringify(entries)
    if (entryFacts !== directoryFacts) {
      if (directoryHandle === null) directoryHandle = ctx.llm.registerConfigurableProviders(entries)
      else directoryHandle.replace(entries)
      directoryFacts = entryFacts
    }
  }

  /** Adopt one resolution result and publish it. */
  function adopt(next) {
    servers = next.routes
    routeErrors = next.errors
    declaredRoutes = next.declared
    for (const message of routeErrors.values()) ctx.logger?.warn?.(message)
    try {
      publish()
    } catch (error) {
      ctx.logger?.warn?.(`dsh-llm-llamacpp: publishing the edited routes failed; ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Re-resolve after a volatile commit (the Models page just wrote the map).
   *
   * Resolution is per entry, so a bad declaration becomes a row error while the
   * working routes stay registered. A publish failure leaves the previous
   * registration in place and is reported; nothing here throws into the loader.
   */
  function refresh() {
    adopt(resolveCurrent())
  }

  adopt(resolveCurrent())

  /**
   * Register the web-only metrics endpoints on a context that has `webServer`.
   *
   * The headless bundle has no web server, so this runs in a nested optional
   * injection: the plugin still registers its routes and directory there, but
   * the metrics dialog and its config endpoint do not exist. In a web profile
   * the child fiber starts as soon as `webServer` is available and is disposed
   * with the parent.
   */
  const registerWebEndpoints = (web) => {
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: '/llamacpp-metrics/live',
      handler: createLiveHandler(ctx, {
        pollMs,
        // Adapter replace is the public route-set mutation point; it publishes
        // `llm/adapters-updated`, which invalidates the browser model catalog.
        onAvailabilityChange: () => {
          const routes = [...servers.keys()]
          if (adapterHandle === null || routes.length === 0) return
          adapterHandle.replace(routes)
        },
      }),
    }))
    // The one fact the client cannot derive: the namespace its provider card must
    // be keyed by (the profile row id, which a composition may have renamed).
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: '/llamacpp-metrics/config',
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 404, { error: 'not-found' })
        json(res, 200, {
          settingsNs,
          routes: [...servers.keys()],
          names: Object.fromEntries([...servers.values()].map((entry) => [entry.provider, displayNameFor(entry.alias)])),
          errors: Object.fromEntries(routeErrors),
          declared: declaredRoutes.map((entry) => entry.provider),
          ...settingsSelfReport(ctx, settingsService, settingsNs),
        })
      },
    }))
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], registerWebEndpoints)
  // Older host contexts (and the suite's minimal apply mock) have no `inject`
  // helper; use a web server that is already present rather than dropping it.
  else if (ctx.webServer !== undefined) registerWebEndpoints(ctx)
  const offUpdate = ctx.on('loader/volatile-update', refresh)
  // The Models page interrogates a draft through the namespace's own discovery.
  const offDiscovery = ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discoverLlamaModels(ctx, request, signal))
  // Reject a settings write the host could not serve before it is committed. The
  // page renders the error message on the card.
  const offConfigValidation = typeof ctx.on === 'function'
    ? ctx.on('internal/config', function (_raw, next) {
      const raw = next()
      if (this !== ctx.fiber) return raw
      const candidate = Config(raw)
      const { errors } = resolveServerProfiles({ servers: unwrapConfig(candidate.servers) })
      if (errors.size > 0) throw new Error([...errors.values()].join('\n'))
      return raw
    })
    : () => {}
  // A rotated credential must invalidate the verdicts/catalogs that were read
  // with the old one, or a 401 stays cached until the next page reload.
  const offCredentials = typeof ctx.on === 'function'
    ? ctx.on('credentials/reference-updated', (ref) => {
      const wanted = String(ref)
      for (const entry of servers.values()) {
        if (entry.apiKeyEnv !== wanted) continue
        verdicts.delete(entry.origin)
        catalogs.delete(entry.origin)
        lastLiveAt.delete(entry.origin)
        probedContextWindows.delete(entry.origin)
        effortCatalog.delete(entry.origin)
      }
    })
    : () => {}
  // Without this the Plugins page would also render a generated form over the same
  // map; the provider card in Models is the editor for these routes. The service is
  // kept for the self-report `/llamacpp-metrics/config` answers.
  ctx.inject?.(['settings'], (child) => {
    settingsService = child.settings
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  return () => {
    if (adapterHandle !== null) adapterHandle()
    adapterHandle = null
    if (directoryHandle !== null) directoryHandle()
    directoryHandle = null
    offUpdate()
    offDiscovery()
    offConfigValidation()
    offCredentials()
    // Everything else is module-level cache. Leaving it behind would let a
    // re-enable (the documented way to load new host JS) serve verdicts,
    // context windows and effort vocabularies from the previous registration.
    resetState()
  }
}

/**
 * Drop every module-level cache and counter. Called from the disposer: the
 * host half is re-applied, not re-imported, when the plugin is toggled.
 */
function resetState() {
  verdicts.clear()
  samples.clear()
  lastLiveAt.clear()
  inflight.clear()
  progress.clear()
  taskStarts.clear()
  rateWindows.clear()
  requestTrace = { at: null, provider: null, model: null, purpose: null, keys: [] }
  streamIdleMs = 300_000
  slotSamples.clear()
  slotAssignments.clear()
  catalogs.clear()
  probedContextWindows.clear()
  effortCatalog.clear()
  requestSeq = 0
  servers = new Map()
  routeErrors = new Map()
  declaredRoutes = []
  contextTrace = null
  effortTrace = null
}

/** Echo the requested model and whether the server currently serves it. */
function withMatch(body, model) {
  const served = [body.servedModel, ...(body.props?.aliases ?? [])].filter(v => typeof v === 'string')
  const normalized = model.trim().toLowerCase()
  const matches = normalized === '' ? null : served.some(v => v.trim().toLowerCase() === normalized)
  return { ...body, servedModelMatches: matches }
}
