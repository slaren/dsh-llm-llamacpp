// Adapter parity: does this plugin's llama.cpp route behave like the shipped
// pi-ai route, measured on the contract the harness actually consumes?
//
// The contract is not "does it throw" but "what does the harness see", because
// retries are decided from the failure code:
//
//   @deepseek-ai/dsh-llm-retry  `recover()` retries only when
//     `policy.retryableCodes.includes(failure.code)` (mode "normal"), honouring
//     `failure.providerRetryAfterMs` and `maxRetries`.
//   @deepseek-ai/dsh-llm        `DEFAULT_RETRYABLE_CODES = [EMPTY_RESPONSE,
//     RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`, and `normalizeLlmFailure` keeps a
//     code ONLY for a HarnessError or for a foreign error whose `failure` snapshot
//     matches its own `code` — everything else becomes UNKNOWN, which is never
//     retried.
//   @deepseek-ai/dsh-llm-pi-ai  classifies upstream text into AUTH, QUOTA,
//     RATE_LIMIT, INVALID_REQUEST, SERVER, TIMEOUT, TRANSPORT, PI_AI_ERROR,
//     CONTEXT_WINDOW_EXCEEDED and EMPTY_RESPONSE, and guards its stream with a
//     300 s idle watchdog → TIMEOUT.
//
// So each scenario below goes through the REAL LlmRuntime (not the adapter
// directly) and asserts the finish reason the agent loop would act on: its kind,
// its failure code, and whether that code is retryable. The pi-ai equivalent is
// named in each check so the expectation has a reference.
//
//   node test/parity-test.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'

const here = dirname(fileURLToPath(import.meta.url))
let failures = 0
let checks = 0
const check = (name, actual, expected) => {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { console.log(`ok   ${name}: ${a}`) ; return }
  failures += 1
  console.log(`FAIL ${name}: ${a} (expected ${e})`)
}
const skip = (name) => { console.log(`skip ${name}`) }

// --- the plugin, loaded with the test hooks the suites use ----------------
const source = readFileSync(join(here, '..', 'index.js'), 'utf8')
// Written inside the package so the module's own bare import (the config schema's
// `@deepseek-ai/schemastery`) resolves exactly as it does under the Loader.
const file = join(here, '.parity.test.generated.mjs')
writeFileSync(file, `${source}
export { llamaStream, createLlamaAdapter }
export const __setLlama = (partial) => { servers.set(partial.provider, { alias: 'llama.cpp', apiKeyEnv: null, ...partial }) }
export const __setStreamIdleMs = (ms) => { streamIdleMs = ms }
export const __setEffortCatalog = (origin, value) => effortCatalog.set(origin, value)
export const __resetState = () => resetState()
`)
const mod = await import(pathToFileURL(file).href)

const findCheckout = () => {
  if (process.env.DSH_CHECKOUT) return process.env.DSH_CHECKOUT
  let walk = here
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(walk, 'node_modules', '@deepseek-ai', 'dsh-llm'))) return walk
    const parent = dirname(walk)
    if (parent === walk) break
    walk = parent
  }
  const npx = join(homedir(), '.npm', '_npx')
  if (existsSync(npx)) {
    for (const entry of readdirSync(npx)) {
      const candidate = join(npx, entry)
      if (existsSync(join(candidate, 'node_modules', '@deepseek-ai', 'dsh-llm'))) return candidate
    }
  }
  return undefined
}
const checkout = findCheckout()
if (checkout === undefined) {
  skip('adapter parity (no dsh checkout found; set DSH_CHECKOUT)')
  console.log('\n0 checks, nothing to compare')
  process.exit(0)
}
const { default: LlmRuntime } = await import(pathToFileURL(join(checkout, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')).href)
const { Context } = await import(pathToFileURL(join(checkout, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)

// --- a fake llama.cpp server whose behaviour switches per scenario ---------
const MODEL = 'parity-model'
let scenario = 'ok'
const hits = { count: 0 }
const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const frame = (content) => sse({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })
const stop = () => sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
const usage = () => sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })
const errorBody = (message, type) => JSON.stringify({ error: { message, type } })

const server = createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (url === '/props') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ default_generation_settings: { n_ctx: 8192 }, total_slots: 1 }))
    return
  }
  if (url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: MODEL, object: 'model' }] }))
    return
  }
  req.on('data', () => {})
  req.on('end', () => {
    hits.count += 1
    const stream = () => { res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' }) }
    switch (scenario) {
      case 'ok':
        stream(); res.end(frame('hello') + stop() + usage() + 'data: [DONE]\n\n'); return
      case 'reasoning-and-content':
        stream(); res.end(
          sse({ choices: [{ index: 0, delta: { reasoning_content: 'think', content: 'answer' }, finish_reason: null }] }) +
          stop() + usage() + 'data: [DONE]\n\n',
        ); return
      case 'rate-limit':
        res.writeHead(429, { 'content-type': 'application/json' }); res.end(errorBody('rate limit exceeded', 'rate_limit')); return
      case 'server':
        res.writeHead(500, { 'content-type': 'application/json' }); res.end(errorBody('internal error', 'server_error')); return
      case 'auth':
        res.writeHead(401, { 'content-type': 'application/json' }); res.end(errorBody('invalid api key', 'auth')); return
      case 'bad-request':
        res.writeHead(400, { 'content-type': 'application/json' }); res.end(errorBody('invalid request: malformed messages', 'invalid_request')); return
      case 'overflow':
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(errorBody('the request exceeds the available context size, try increasing it', 'exceed_context_size_error')); return
      case '408-timeout':
        res.writeHead(408, { 'content-type': 'text/plain' }); res.end('Request Timeout'); return
      case '408-empty':
        res.writeHead(408, { 'content-type': 'text/plain' }); res.end(); return
      case 'empty':
        stream(); res.end(stop() + usage() + 'data: [DONE]\n\n'); return
      case 'done-only':
        stream(); res.end('data: [DONE]\n\n'); return
      case 'malformed':
        stream(); res.end(frame('hello') + 'data: {not-json}\n\n' + stop() + usage() + 'data: [DONE]\n\n'); return
      case 'content-filter':
        stream(); res.end(frame('blocked') + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }) + 'data: [DONE]\n\n'); return
      case 'unknown-finish':
        stream(); res.end(frame('x') + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'new_state' }] }) + 'data: [DONE]\n\n'); return
      case 'cut':
        stream(); res.write(frame('partial')); setTimeout(() => res.destroy(), 40); return
      case 'idle':
        stream(); res.write(frame('partial')); return // never ends, never closes
      case 'hang':
        return // accepted, but never sends response headers
      case 'stall-error':
        res.writeHead(500, { 'content-type': 'text/plain' }); res.write('partial error body'); return
      case 'error-frame':
        stream(); res.end(sse({ error: { message: 'failed to allocate the KV cache', type: 'server_error' } })); return
      case 'error-frame-overflow':
        stream(); res.end(sse({ error: { message: 'context window exceeded', type: 'exceed_context_size_error' } })); return
      case 'no-stream':
        stream(); res.end(); return
      default:
        res.writeHead(500); res.end()
    }
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const origin = `http://127.0.0.1:${port}`

// --- the real runtime, our adapter registered as a provider route ----------
const ctx = new Context()
const runtime = new LlmRuntime(ctx)
ctx.llm = runtime
const provider = 'parity'
// Declared routes, no sidecar name, no interception of another provider.
const route = provider
mod.__setLlama({ provider, baseURL: `${origin}/v1`, origin, apiKeyEnv: null })
runtime.registerAdapter([route], mod.createLlamaAdapter(ctx))

const RETRYABLE = new Set(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
const stream = async ({ signal } = {}) => {
  let finish = null
  const chunks = []
  for await (const chunk of runtime.stream({ provider: route, model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], ...(signal === undefined ? {} : { signal }) })) {
    chunks.push(chunk.type)
    if (chunk.type === 'finish') finish = chunk.reason
  }
  return { finish, chunks }
}
const settle = async (name) => {
  // The attempt either finishes or throws; the runtime reports both as a failure.
  try {
    return await stream()
  } catch (error) {
    return { thrown: error?.code ?? error?.message ?? String(error) }
  }
}

console.log('\n-- a successful turn (the shape pi-ai produces) --')
scenario = 'ok'
{
  const { finish, chunks } = await settle('ok')
  check('a normal stream finishes with stop', finish?.kind, 'stop')
  check('text arrives as a block plus deltas', chunks.filter((type) => type !== 'usage'), ['block-start', 'text-delta', 'block-end', 'finish'])
  check('a usage chunk is emitted', chunks.includes('usage'), true)
}

console.log('\n-- reasoning and text in one delta --')
scenario = 'reasoning-and-content'
{
  const { finish, chunks } = await settle('reasoning-and-content')
  check('a mixed delta finishes with stop', finish?.kind, 'stop')
  check(
    'both reasoning and text deltas are emitted',
    chunks.filter((type) => type === 'reasoning-delta' || type === 'text-delta'),
    ['reasoning-delta', 'text-delta'],
  )
}

console.log('\n-- failures the retry policy routes on --')
// A short ceiling keeps the stalled scenario quick; it is the same guard.
mod.__setStreamIdleMs(600)
const matrix = [
  // scenario, expected code, pi-ai reference
  ['rate-limit', 'RATE_LIMIT', 'classifyPiAiError: /\\b429\\b|rate.?limit/ → RATE_LIMIT'],
  ['server', 'SERVER', 'classifyPiAiError: /\\b5\\d\\d\\b/ → SERVER'],
  ['auth', 'AUTH', 'classifyPiAiError: /\\b(?:401|403)\\b/ → AUTH'],
  ['bad-request', 'INVALID_REQUEST', 'classifyPiAiError: /\\b400\\b|invalid.?request/ → INVALID_REQUEST'],
  ['overflow', 'CONTEXT_WINDOW_EXCEEDED', 'isContextWindowExceededError → CONTEXT_WINDOW_EXCEEDED'],
  ['408-timeout', 'TIMEOUT', 'every 408 is TIMEOUT in this adapter'],
  ['408-empty', 'TIMEOUT', 'every 408 is TIMEOUT in this adapter'],
  ['empty', 'EMPTY_RESPONSE', 'mapStopReason: stop with no content → EMPTY_RESPONSE'],
  ['done-only', 'TRANSPORT', 'pi-ai: a stream ending without finish_reason is TRANSPORT'],
  ['malformed', 'LLAMA_CPP_ERROR', 'terminal plugin code (pi-ai uses PI_AI_ERROR)'],
  ['content-filter', 'LLAMA_CPP_ERROR', 'terminal plugin code (pi-ai uses PI_AI_ERROR)'],
  ['unknown-finish', 'LLAMA_CPP_ERROR', 'terminal plugin code (pi-ai uses PI_AI_ERROR)'],
  ['cut', 'TRANSPORT', 'classifyPiAiError: terminated/premature close → TRANSPORT (retryable)'],
  ['idle', 'TIMEOUT', 'idleWatchdog → "pi-ai stream idle timeout" TIMEOUT'],
  ['hang', 'TIMEOUT', 'pi-ai idleWatchdog covers the wait for response headers → TIMEOUT'],
  ['stall-error', 'TIMEOUT', 'pi-ai idleWatchdog covers a stalled non-200 error body → TIMEOUT'],
  ['error-frame', 'SERVER', 'mid-stream error → a provider failure, retryable'],
  ['error-frame-overflow', 'CONTEXT_WINDOW_EXCEEDED', 'overflow wording beats the generic failure'],
  ['no-stream', 'STREAM_CLOSED', 'STREAM_CLOSED: stream ended with no terminal event (terminal)'],
]
for (const [name, expected, reference] of matrix) {
  scenario = name
  const { finish } = await settle(name)
  if (process.env.PARITY_TRACE === '1') console.log('     finish:', JSON.stringify(finish))
  const code = finish?.failure?.code
  check(`${name} → ${expected}`, [finish?.kind, code], ['error', expected])
  check(`${name} retryable=${RETRYABLE.has(expected)}`, RETRYABLE.has(code ?? ''), RETRYABLE.has(expected))
  console.log(`     reference: ${reference}`)
}

console.log('\n-- the idle guard must not fire on a healthy stream --')
mod.__setStreamIdleMs(3000)
scenario = 'ok'
mod.__setStreamIdleMs(3000)
{
  const { finish } = await settle('ok')
  check('a fast stream is untouched by the guard', finish?.kind, 'stop')
}
console.log('\n-- an abort is a cancellation, not a failure --')
scenario = 'idle'
mod.__setStreamIdleMs(30_000)
{
  const controller = new AbortController()
  const pending = stream({ signal: controller.signal })
  setTimeout(() => controller.abort(), 300)
  const { finish } = await pending.catch(() => ({ finish: null }))
  check('an aborted stream reports the aborted finish', finish?.kind, 'aborted')
  check('and reports the ABORTED code pi-ai uses', finish?.failure?.code, 'ABORTED')
}

console.log('\n-- request shape parity (what pi-ai sends, what we send) --')
{
  // Capture the body the server receives, so the mapping is asserted on the wire.
  let body = null
  server.prependListener('request', (req) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => { if (raw !== '') { try { body = JSON.parse(raw) } catch { body = null } } })
  })
  scenario = 'ok'
  mod.__setStreamIdleMs(3000)
  const tool = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
  const deferredTool = { name: 'later', description: 'Deferred', parameters: { type: 'object' }, deferLoading: true }
  hits.count = 0
  let finish = null
  for await (const chunk of runtime.stream({
    provider: route,
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    system: 'you are terse',
    tools: [tool, deferredTool],
    temperature: 0.3,
    maxTokens: 64,
    stop: ['\n\n'],
  })) if (chunk.type === 'finish') finish = chunk.reason
  check('the turn still completes', finish?.kind, 'stop')
  check('one upstream attempt per stream', hits.count, 1)
  check('the system prompt is mapped into the messages', body?.messages?.[0], { role: 'system', content: 'you are terse' })
  // WHICH tools survive is the runtime's decision (dsh-llm strips `deferLoading`
  // from every definition before dispatch, `lib/index.js:789`); what this adapter
  // owes is the OAI shape and no `deferLoading` key leaking onto the wire.
  check('tools are mapped into OAI function shape',
    body?.tools, [
      { type: 'function', function: { name: 'read', description: 'Read a file', parameters: tool.parameters } },
      { type: 'function', function: { name: 'later', description: 'Deferred', parameters: { type: 'object' } } },
    ])
  check('no deferLoading key reaches the server', (body?.tools ?? []).some((entry) => 'deferLoading' in entry), false)
  check('sampling options are forwarded', [body?.temperature, body?.max_tokens], [0.3, 64])
  // pi-ai REFUSES `stop` (UNSUPPORTED_OPTION); llama.cpp supports it. Supporting it
  // is a deliberate difference, asserted so it cannot vanish silently.
  check('stop sequences are honoured (llama.cpp supports what pi-ai refuses)', body?.stop, ['\n\n'])
  check('streaming options the adapter needs are present',
    [body?.stream, body?.stream_options?.include_usage, body?.return_progress, body?.timings_per_token],
    [true, true, true, true])
}

console.log('\n-- compaction preserves the routed reasoning effort --')
{
  // pi-ai's generic compaction path does not pass the session's effort, so its
  // summary request falls back to the route default and changes the chat-template
  // prefix. This adapter deliberately recovers the routed effort for compaction;
  // the check runs through the real LlmRuntime, not the adapter directly.
  const session = {
    requestHeader: () => ({ config: { provider: route, model: MODEL, reasoningEffort: 'low' } }),
  }
  const disposeSessions = ctx.provide('sessions', { get: (id) => id === 'effort-session' ? session : undefined })
  await runtime.resolveModelInfo(route, MODEL)
  mod.__setEffortCatalog(origin, { mode: 'standard', levels: new Set(['none', 'low', 'medium', 'high']), defaultLevel: 'medium', offValue: 'none' })
  let body = null
  server.prependListener('request', (req) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => { if (raw !== '') { try { body = JSON.parse(raw) } catch { body = null } } })
  })
  scenario = 'ok'
  mod.__setStreamIdleMs(3000)
  let finish = null
  for await (const chunk of runtime.stream({
    provider: route,
    model: MODEL,
    sessionId: 'effort-session',
    purpose: 'compaction',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize' }] }],
  })) if (chunk.type === 'finish') finish = chunk.reason
  check('the compaction request uses the routed effort', body?.reasoning_effort, 'low')
  check('the compaction request still finishes', finish?.kind, 'stop')
  // The fallback is generic: another defaulted one-shot in the same session
  // inherits the same effort, not just compaction.
  body = null
  finish = null
  for await (const chunk of runtime.stream({
    provider: route,
    model: MODEL,
    sessionId: 'effort-session',
    purpose: 'session-title',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'title' }] }],
  })) if (chunk.type === 'finish') finish = chunk.reason
  check('a defaulted title request uses the routed effort too', body?.reasoning_effort, 'low')
  check('the title request still finishes', finish?.kind, 'stop')
  disposeSessions?.()
}

server.closeAllConnections?.()
server.close()
mod.__resetState()
console.log(`\n${checks} checks, ${failures} failed${failures === 0 ? ' — ALL CHECKS PASSED' : ''}`)
if (failures !== 0) process.exit(1)
