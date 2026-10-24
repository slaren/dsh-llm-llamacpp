// Regression suite for the host half, driven against a live llama.cpp server.
//
//   LLAMA_CPP_BASE=http://host:9931/v1 LLAMA_CPP_MODEL=<id> node test/host-test.mjs
//
// The live section needs a reachable server; every other check is offline.
// Override the provider name with LLAMA_CPP_PROVIDER when the plugin's configured
// route is named differently (it is ONE route, declared in the plugin config).
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageVersion = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version
const source = readFileSync(join(here, '..', 'index.js'), 'utf8')
// Test-only surface: the module keeps these private to the host half.
const patched = source + `
export { llamaStream, reasoningInfo, mapUsage, toOpenAiMessages, createLiveHandler }
// Install (or re-point) ONE declared route. Omitted fields fall back to the route
// already installed, and a call without a provider re-points the last one - which is
// how the suite drove the single-route state before the map existed.
// (No backticks here: this text lives inside the template literal that builds the module.)
let __currentRoute = 'llamacpp'
export const __setLlama = (partial) => {
  __currentRoute = partial.provider ?? __currentRoute
  servers.set(__currentRoute, { alias: 'local', apiKeyEnv: null, ...servers.get(__currentRoute), ...partial, provider: __currentRoute })
}
export const __progress = () => progress
export const __liveProgress = () => liveProgress()
export const __requestTrace = () => requestTrace
export const __clearCatalogs = () => catalogs.clear()
export { createLlamaAdapter, probeOrigin, normalizeProps, normalizeSlots, rateSlots, takeSsePayloads, labelProgress, parseMetrics, deriveMetrics, parseEffortOffer, probeEfforts, resolveEffort, applyEffort, catalogFor }
export const __effortCatalog = (origin) => effortCatalog.get(origin)
export const __setEffortCatalog = (origin, value) => value === undefined ? effortCatalog.delete(origin) : effortCatalog.set(origin, value)
export const __setStreamIdleMs = (ms) => { streamIdleMs = ms }
export const __forgetCatalog = (origin) => catalogs.delete(origin)
export const __catalogFor = (origin) => catalogs.get(origin)
export const __setCatalog = (origin, value) => catalogs.set(origin, value)
export const __deleteLlama = (provider) => servers.delete(provider)
`
// The patched module is written INSIDE the package so its own bare imports (the
// config schema's `@deepseek-ai/schemastery`) resolve the same way they do when
// the Loader imports the plugin. A /tmp copy cannot see the plugin's node_modules.
const file = join(here, '.index.test.generated.mjs')
writeFileSync(file, patched)
const mod = await import(pathToFileURL(file).href)

// A finished request is held for a moment (see the held-rows section), so a
// section that inspects the map clears it first rather than inheriting rows.
const clearProgress = () => { mod.__progress().clear() }

// The plugin owns exactly ONE route now, declared in its config; there is no
// stock provider to rewrite and no `-native` twin, so the name a section passes
// to `llamaStream`/`runtime.stream` must be the name installed here.
const provider = process.env.LLAMA_CPP_PROVIDER ?? 'llamacpp'
const route = provider
const baseURL = process.env.LLAMA_CPP_BASE ?? 'http://127.0.0.1:9931/v1'
const model = process.env.LLAMA_CPP_MODEL ?? 'ggml-org/Qwen3.8-Flash-NEXT-GGUF:IQ4_NL'
const origin = new URL(baseURL).origin
/** Point the single configured route at the live server. */
const installLive = (over = {}) => mod.__setLlama({
  provider: route, alias: 'local', baseURL, origin, apiKeyEnv: null, ...over,
})
installLive()

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ' (expected ' + JSON.stringify(expected) + ')'}`)
}
const skip = (label) => console.log(`skip ${label}: the live server is not answering`)

// The sections below need a reachable llama-server. When it is down — or still
// loading a model — the checks that depend on it report a skip instead of
// failing, so an offline run still exercises everything else (and never crashes
// on a null probe).
const serverUp = (await mod.probeOrigin(origin)).state === 'llama'
if (!serverUp) console.log(`\nnote: ${origin} is not answering as llama.cpp — checks that need it are skipped`)

// --- 1b'. the REAL runtime must accept the effort the picker persists -------
// The model picker resolves `defaultEffort` from this adapter and stores it on
// `model/selection`; the request path validates it against the descriptor
// `prepareCall` returns. Those two must be the same descriptor, or a selected
// effort fails with UNSUPPORTED_REASONING_EFFORT at step 1 of the next turn.
console.log('\n-- prepareCall through the real runtime --')
const { existsSync, readdirSync } = await import('node:fs')
const { homedir } = await import('node:os')
// The plugin half is linked into a profile, where dsh's own packages do not
// resolve; find the checkout the running Harness was installed from instead.
const findCheckout = () => {
  if (process.env.DSH_CHECKOUT) return process.env.DSH_CHECKOUT
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Local convenience: this environment's running Harness was launched from
  // npx's cache. Absent elsewhere, which only skips the check.
  let npx = join(homedir(), '.npm', '_npx')
  if (existsSync(npx)) {
    for (const entry of readdirSync(npx)) {
      const candidate = join(npx, entry)
      if (existsSync(join(candidate, 'node_modules', '@deepseek-ai', 'dsh-llm'))) return candidate
    }
  }
  return undefined
}
let runtimeCheck = 'skipped (no dsh checkout found)'
try {
  const checkout = findCheckout()
  if (checkout === undefined) throw new Error('no node_modules/@deepseek-ai/dsh-llm above the plugin')
  const llmEntry = join(checkout, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')
  const cordisEntry = join(checkout, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')
  const { default: LlmRuntime } = await import(pathToFileURL(llmEntry).href)
  const { Context } = await import(pathToFileURL(cordisEntry).href)
  const ctx = new Context()
  const runtime = new LlmRuntime(ctx)
  ctx.llm = runtime
  runtime.registerAdapter([route], mod.createLlamaAdapter(ctx))
  const prepared = await runtime.prepareCall({ provider: route, model, reasoningEffort: 'medium' })
  check('runtime accepts the persisted effort', prepared.config.reasoningEffort, 'medium')
  if (serverUp) check('runtime sees the context window', typeof prepared.context?.contextWindow, 'number')
  else skip('runtime sees the context window')
  const info = await runtime.resolveModelInfo(route, model)
  if (serverUp) {
    const extra = await runtime.prepareCall({ provider: route, model, reasoningEffort: 'xhigh' })
    check('runtime accepts the server default effort', extra.config.reasoningEffort, 'xhigh')
    let rejected = null
    try {
      await runtime.prepareCall({ provider: route, model, reasoningEffort: 'high' })
    } catch (error) {
      rejected = error.code ?? error.failure?.code ?? null
    }
    check('runtime rejects a level the server does not offer', rejected, 'UNSUPPORTED_REASONING_EFFORT')
    check('picker advertises the server levels', info.reasoning?.efforts.map(e => e.id), ['off', 'low', 'medium', 'xhigh'])
    check('picker advertises the server default', info.reasoning?.defaultEffort, 'xhigh')
  } else {
    check('picker falls back to the standard levels', info.reasoning?.efforts.map(e => e.id), ['off', 'low', 'medium', 'high'])
    check('picker falls back to the standard default', info.reasoning?.defaultEffort, 'medium')
  }
  // The model picker builds its catalog from the registered adapter, so the
  // route must answer `listModels` itself.
  if (serverUp) {
    const listed = await runtime.listModels(route)
    check('the registered route lists its models', listed.some(m => m.id === model), true)
  } else skip('the registered route lists its models')
  runtimeCheck = 'checked'
} catch (error) {
  console.log(`skip runtime check: ${error.message}`)
}
console.log(`   (runtime descriptor check: ${runtimeCheck})`)

// --- 1c. context window and output cap come from the server --------------
// The profile carries no capability numbers: `/v1/models` and `/props` are the
// only sources. `/props` must still answer when the model list does not, because
// it is the server's own statement of its context and default output cap.
console.log('\n-- context window --')
const contextAdapter = mod.createLlamaAdapter({ attachments: {} })
if (serverUp) {
  installLive()
  mod.__clearCatalogs()
  const catalogModel = await contextAdapter.resolveModel(route, model)
  check('live catalog provides a window', typeof catalogModel.context?.contextWindow, 'number')
} else skip('live catalog provides a window')

// A server whose /v1/models is missing but whose /props reports n_ctx: the
// descriptor still gets the window, and the alias becomes the model entry.
{
  const http = await import('node:http')
  const local = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not found"}')
      return
    }
    if (req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model_alias: 'qwen',
        modalities: { vision: true },
        total_slots: 1,
        default_generation_settings: { n_ctx: 32768, params: { n_predict: 512 } },
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve))
  const localOrigin = `http://127.0.0.1:${local.address().port}`
  try {
    mod.__setLlama({ provider: route, baseURL: localOrigin + '/v1', origin: localOrigin })
    mod.__clearCatalogs()
    const propsModel = await contextAdapter.resolveModel(route, 'qwen')
    check('props supplies the window when the model list is missing', propsModel.context?.contextWindow, 32768)
    check('props supplies the default output cap', propsModel.defaultMaxTokens, 512)
    const listed = await contextAdapter.listModels(route)
    check('the alias becomes a model entry', listed.map((entry) => entry.id), ['qwen'])
    check('props supplies the model modalities', listed[0].inputModalities, ['text', 'image'])
  } finally {
    local.close()
  }
}

// A /v1/models row without an architecture block must not hide /props vision.
{
  const http = await import('node:http')
  const local = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'qwen', object: 'model' }] }))
      return
    }
    if (req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'qwen', modalities: { vision: true }, default_generation_settings: { n_ctx: 32768 } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve))
  const localOrigin = `http://127.0.0.1:${local.address().port}`
  try {
    mod.__setLlama({ provider: route, baseURL: localOrigin + '/v1', origin: localOrigin })
    mod.__clearCatalogs()
    const listed = await contextAdapter.listModels(route)
    check('props vision applies when the model row has no architecture',
      listed[0]?.inputModalities, ['text', 'image'])
  } finally {
    local.close()
  }
}

// A template that rejects a leading system message is detected once and the
// adapter folds system content into the first user turn for that origin.
{
  const http = await import('node:http')
  let allowSystem = false
  let probeBroken = false
  const local = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'qwen', object: 'model' }] }))
      return
    }
    if (req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        chat_template: '{{ messages }}',
        default_generation_settings: { n_ctx: 32768 },
      }))
      return
    }
    if (req.url === '/apply-template') {
      if (probeBroken) { req.socket.destroy(); return }
      res.writeHead(allowSystem ? 200 : 500, { 'content-type': 'application/json' })
      res.end(JSON.stringify(allowSystem ? { prompt: 'ok' } : { error: { message: 'System role not supported' } }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve))
  const localOrigin = `http://127.0.0.1:${local.address().port}`
  try {
    mod.__setLlama({ provider: route, baseURL: localOrigin + '/v1', origin: localOrigin })
    mod.__clearCatalogs()
    await contextAdapter.listModels(route)
    check('a template without system support is detected', mod.__catalogFor(localOrigin).systemRole, false)
    probeBroken = true
    const stale = mod.__catalogFor(localOrigin)
    mod.__setCatalog(localOrigin, { ...stale, at: Date.now() - stale.ttlMs - 1 })
    await contextAdapter.listModels(route)
    check('an inconclusive system probe keeps the last known answer', mod.__catalogFor(localOrigin).systemRole, false)
    probeBroken = false
    allowSystem = true
    mod.__clearCatalogs()
    await contextAdapter.listModels(route)
    check('a template with system support is detected', mod.__catalogFor(localOrigin).systemRole, true)
  } finally {
    local.close()
  }
}

// The server's loaded context (`/props`) must win over `/v1/models`' `meta.n_ctx`.
// Both are loaded-context figures; `n_ctx_train` is the training context. A server
// started with a smaller `-c` otherwise reports a window the model cannot hold, so
// compaction plans against the wrong ceiling.
{
  const http = await import('node:http')
  const local = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'qwen', name: 'qwen', meta: { n_ctx: 262144 } }] }))
      return
    }
    if (req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model_alias: 'qwen',
        total_slots: 1,
        default_generation_settings: { n_ctx: 131072, params: { n_predict: -1 } },
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve))
  const localOrigin = `http://127.0.0.1:${local.address().port}`
  try {
    mod.__setLlama({ provider: route, baseURL: localOrigin + '/v1', origin: localOrigin })
    mod.__clearCatalogs()
    const loaded = await contextAdapter.resolveModel(route, 'qwen')
    check('loaded context wins over the catalog context', loaded.context?.contextWindow, 131072)
    check('catalog records props as the context source', (await mod.catalogFor(localOrigin)).contextSource, 'props')
  } finally {
    local.close()
    installLive()
  }
}

check('normalizeProps reads default_generation_settings', mod.normalizeProps({ total_slots: 4, default_generation_settings: { n_ctx: 123456 } })?.nCtx, 123456)
check('normalizeProps reads the slot count', mod.normalizeProps({ total_slots: 4 })?.totalSlots, 4)
check('normalizeProps ignores the unlimited sentinel', mod.normalizeProps({ default_generation_settings: { params: { n_predict: -1, max_tokens: -1 } } })?.defaultMaxTokens, undefined)
if (serverUp) {
  const probedVerdict = await mod.probeOrigin(origin)
  check('probe records the server n_ctx', typeof probedVerdict.props?.nCtx, 'number')
} else skip('the /props context tier')

// Nothing anywhere: the descriptor omits the window rather than inventing one.
mod.__setLlama({ provider: route, baseURL: 'http://127.0.0.1:1/v1', origin: 'http://127.0.0.1:2' })
mod.__clearCatalogs()
const bare = await contextAdapter.resolveModel(route, model)
check('no tier answers, no window is invented', 'context' in bare, false)
check('the descriptor uses in-history system updates', bare.systemPromptUpdate, 'in-history')
installLive()

// --- 1d. usage buckets are DISJOINT --------------------------------------
// The harness counts `inputTokens + cacheReadTokens + cacheWriteTokens`, and
// llama.cpp's OpenAI-shaped `prompt_tokens` INCLUDES the cached prefix, so
// passing it through unchanged double-counted every cached turn (~2x the real
// context pressure). The numbers below are a real turn captured from this
// route's own session log.
console.log('\n-- usage buckets --')
check('cached prompt tokens are subtracted from input',
  mod.mapUsage({ prompt_tokens: 49135, completion_tokens: 140, total_tokens: 49275, prompt_tokens_details: { cached_tokens: 47604 } }),
  { type: 'usage', usage: { inputTokens: 1531, outputTokens: 140, totalTokens: 49275, cacheReadTokens: 47604 } })
check('legacy cache field is honoured',
  mod.mapUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 40 }),
  { type: 'usage', usage: { inputTokens: 60, outputTokens: 10, totalTokens: 110, cacheReadTokens: 40 } })
check('an uncached turn reports no cache bucket',
  mod.mapUsage({ prompt_tokens: 100, completion_tokens: 10 }),
  { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } })
check('a missing usage object yields no chunk', mod.mapUsage(undefined), null)
check('a non-object usage yields no chunk', mod.mapUsage(null), null)
{
  const usage = mod.mapUsage({ prompt_tokens: 49135, completion_tokens: 140, prompt_tokens_details: { cached_tokens: 47604 } }).usage
  check('buckets stay disjoint', usage.inputTokens + (usage.cacheReadTokens ?? 0), 49135)
  check('the disjoint total matches the provider total', usage.inputTokens + (usage.cacheReadTokens ?? 0) + usage.outputTokens, usage.totalTokens)
}

// --- 1e. images and files reach the wire correctly ------------------------
// `ImageAttachmentRef` carries `mediaType` (there is no `mimeType`), so the old
// lookup always labeled every image `image/png`; the request must also go
// through the route's image target rather than the stored original.
console.log('\n-- image / file parts --')
const jpegRef = { attachmentId: 'a', mediaType: 'image/jpeg', bytes: 3, width: 2, height: 2, name: 'photo.jpg' }
const imageCtx = {
  llm: {
    imageRequestTarget: (_p, _m, ref) => ({ width: ref.width, height: ref.height, maxBytes: ref.bytes }),
    fileRequestText: (ref) => `[file ${ref.name} (1 byte)]`,
  },
  attachments: { readImageRequest: async () => ({ mediaType: 'image/jpeg', data: new Uint8Array([1, 2, 3]), width: 2, height: 2 }) },
}
const imageOptions = { provider: route, model }
check('an image uses the stored media type',
  (await mod.toOpenAiMessages(imageCtx, { ...imageOptions, messages: [{ role: 'user', content: [{ type: 'image', attachment: jpegRef }] }] }))[0].content[1].image_url.url,
  'data:image/jpeg;base64,AQID')
check('an offloaded image is never re-sent',
  (await mod.toOpenAiMessages(imageCtx, { ...imageOptions, messages: [{ role: 'user', content: [{ type: 'image', attachment: jpegRef, offloaded: true }] }] }))[0].content,
  '[image omitted to fit request image limits; "photo.jpg" (a). No local normalized image path is available; ask the user to attach it again if needed.]')
check('a file block carries the harness handle text',
  (await mod.toOpenAiMessages(imageCtx, { ...imageOptions, messages: [{ role: 'user', content: [{ type: 'file', attachment: { attachmentId: 'f', name: 'a.txt', bytes: 1 } }] }] }))[0].content,
  '[file a.txt (1 byte)]')
check('an unreadable image degrades to a text marker',
  (await mod.toOpenAiMessages({ ...imageCtx, attachments: { readImageRequest: async () => { throw new Error('gone') } } }, { ...imageOptions, messages: [{ role: 'user', content: [{ type: 'image', attachment: jpegRef }] }] }))[0].content,
  '[image unavailable]')

// --- 1e'. assistant reasoning reaches the wire as reasoning_content ------
// llama.cpp preserves reasoning only when the assistant turn carries the
// `reasoning_content` field. Dropping it leaves the token meter pricing content
// the model never sees, which makes compaction fire early.
console.log('\n-- assistant reasoning replay --')
const sameSource = { kind: 'model', provider: route, model }
const reasoningOptions = { provider: route, model }
const assistantWire = async (content, source = sameSource) => (
  await mod.toOpenAiMessages({}, {
    ...reasoningOptions,
    messages: [{ role: 'assistant', content, ...(source === undefined ? {} : { source }) }],
  })
)[0]
{
  const textWire = await assistantWire([
    { type: 'reasoning', text: 'first thought' },
    { type: 'reasoning', text: 'second thought' },
    { type: 'text', text: 'answer' },
  ])
  check('assistant reasoning is replayed as reasoning_content', textWire.reasoning_content, 'first thought\n\nsecond thought')
  check('assistant text stays in content', textWire.content, 'answer')

  const toolWire = await assistantWire([
    { type: 'reasoning', text: 'call the reader' },
    { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"/etc/hostname"}' },
  ])
  check('reasoning with a tool call keeps content null', toolWire.content, null)
  check('reasoning with a tool call is replayed', toolWire.reasoning_content, 'call the reader')
  check('reasoning with a tool call keeps the call', toolWire.tool_calls?.[0]?.id, 'c1')

  const reasoningOnly = await assistantWire([{ type: 'reasoning', text: 'only thought' }])
  check('reasoning-only assistant is replayed', [reasoningOnly.content, reasoningOnly.reasoning_content], [null, 'only thought'])

  const other = await assistantWire(
    [{ type: 'reasoning', text: 'other model thought' }, { type: 'text', text: 'answer' }],
    { kind: 'model', provider: route, model: 'other-model' },
  )
  check('reasoning from another model is not replayed', other.reasoning_content, undefined)
  check('text from another model is still replayed', other.content, 'answer')

  const unattributed = await assistantWire(
    [{ type: 'reasoning', text: 'legacy thought' }, { type: 'text', text: 'legacy answer' }],
    undefined,
  )
  check('unattributed legacy reasoning is replayed', unattributed.reasoning_content, 'legacy thought')

  const blank = await mod.toOpenAiMessages({}, {
    ...reasoningOptions,
    messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: '   ' }], source: sameSource }],
  })
  check('a blank reasoning-only assistant is skipped', blank.length, 0)
}

// --- 1e'. tool-result content follows pi-ai's projection ------------------
// An OpenAI tool message carries text only. pi-ai sends the text result on the
// tool message, then one user message with every image from a run of tool
// results. Empty and image-only results get the same placeholders.
console.log('\n-- tool result content --')
{
  const image = (name = 'a.png') => ({
    type: 'image',
    attachment: { attachmentId: name, name, width: 1, height: 1, bytes: 3 },
  })
  const ctx = {
    llm: { imageRequestTarget: () => ({ width: 1, height: 1, maxBytes: 3 }) },
    attachments: {
      readImageRequest: async () => ({ data: Buffer.from('png'), mediaType: 'image/png', width: 1, height: 1 }),
    },
  }
  const wire = (content) => mod.toOpenAiMessages(ctx, {
    provider: 'p',
    model: 'm',
    messages: [{ role: 'tool', toolCallId: 'c1', content }],
  })
  const mixed = await wire([
    { type: 'text', text: 'first' },
    image(),
    { type: 'text', text: 'second' },
  ])
  check('mixed tool text stays on the tool message', mixed[0],
    { role: 'tool', tool_call_id: 'c1', content: 'first\nImage "a.png" (a.png); request preview 1x1px. It may be resized or re-encoded; source dimensions, format, and byte size may differ.\nsecond' })
  check('mixed tool image follows as a user image message', mixed[1],
    { role: 'user', content: [
      { type: 'text', text: 'Attached image(s) from tool result:' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } },
    ] })

  const userImage = await mod.toOpenAiMessages(ctx, {
    provider: 'p',
    model: 'm',
    messages: [{ role: 'user', content: [image()] }],
  })
  check('a user image carries the same handle text',
    userImage[0].content[0].text,
    'Image "a.png" (a.png); request preview 1x1px. It may be resized or re-encoded; source dimensions, format, and byte size may differ.')
  check('a user image still carries the image part', userImage[0].content[1].type, 'image_url')

  const imageOnly = await wire([image()])
  check('image-only tool result gets the image handle text', imageOnly[0].content,
    'Image "a.png" (a.png); request preview 1x1px. It may be resized or re-encoded; source dimensions, format, and byte size may differ.')
  check('image-only tool result still carries the image', imageOnly[1]?.content?.[1]?.type, 'image_url')

  const empty = await wire([])
  check('empty tool result gets the no-output placeholder', empty[0].content, '(no tool output)')
  check('empty tool result adds no image message', empty.length, 1)

  const textOnly = await wire([{ type: 'text', text: 'plain' }])
  check('text-only tool result adds no image message', textOnly, [{ role: 'tool', tool_call_id: 'c1', content: 'plain' }])

  const offloaded = await wire([{ ...image(), offloaded: true }])
  check('offloaded tool image becomes text', offloaded, [{ role: 'tool', tool_call_id: 'c1', content: '[image omitted to fit request image limits; "a.png" (a.png). No local normalized image path is available; ask the user to attach it again if needed.]' }])
  const offloadedWithPath = await mod.toOpenAiMessages({
    ...ctx,
    get: (name) => name === 'fs' ? { processPathFromHostPath: () => '/work/a.png' } : undefined,
    attachments: { ...ctx.attachments, imageHostPath: () => '/host/a.png' },
  }, {
    provider: 'p',
    model: 'm',
    messages: [{ role: 'tool', toolCallId: 'c1', content: [{ ...image(), offloaded: true }] }],
  })
  check('an offloaded image carries the normalized path when available',
    String(offloadedWithPath[0]?.content).includes('/work/a.png'), true)

  const consecutive = await mod.toOpenAiMessages(ctx, {
    provider: 'p',
    model: 'm',
    messages: [
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'one' }, image('one.png')] },
      { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'two' }, image('two.png')] },
    ],
  })
  check('consecutive tool results keep their own text',
    consecutive.slice(0, 2).map((m) => m.content.split('\n')[0]), ['one', 'two'])
  check('consecutive tool results share one trailing image message', consecutive.length, 3)
  check('the shared image message is a user message', consecutive[2].role, 'user')
  check('the shared image message carries both images',
    consecutive[2].content.filter((part) => part.type === 'image_url').length, 2)
}

// --- 1e4. the server's media marker is defused in outgoing text ------------
// llama.cpp treats its own random `media_marker` as an image placeholder
// anywhere in the rendered prompt. A tool result that echoed `/props` is still
// ordinary text, but the next request would fail with HTTP 400 "Failed to
// tokenize prompt" unless the marker is broken up before it leaves the adapter.
console.log('\n-- media marker in text --')
{
  const { createServer } = await import('node:http')
  const marker = '<__media_dshTestMarker42__>'
  const defused = '<\u200b' + marker.slice(1)
  let captured = null
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'm', name: 'm', architecture: { input_modalities: ['text'] } }] }))
        return
      }
      if (req.url === '/props') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          model_alias: 'm',
          total_slots: 1,
          media_marker: marker,
          default_generation_settings: { n_ctx: 4096, params: { n_predict: -1 } },
        }))
        return
      }
      try { captured = JSON.parse(raw) } catch { captured = null }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const mediaOrigin = `http://127.0.0.1:${server.address().port}`
  mod.__setLlama({ provider: 'media-test', baseURL: mediaOrigin + '/v1', origin: mediaOrigin, apiKeyEnv: null })
  try {
    mod.__clearCatalogs()
    const catalog = await mod.catalogFor(mediaOrigin)
    check('the catalog records the media marker', catalog.mediaMarker, marker)

    captured = null
    for await (const chunk of mod.llamaStream({ attachments: {} }, {
      provider: 'media-test',
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: `inspect ${marker}` }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: `{"marker":"${marker}"}` }] },
        { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: `media_marker: ${marker}` }] },
      ],
      tools: [{ name: 'bash', description: `echo ${marker}`, parameters: { type: 'object', properties: {} } }],
    })) void chunk

    const wire = JSON.stringify(captured)
    check('the outgoing request contains no raw media marker', wire.includes(marker), false)
    check('the marker is defused with a zero-width space', wire.includes(defused), true)
    check('defusing preserves the visible text',
      captured?.messages?.[0]?.content?.replace('\u200b', ''), `inspect ${marker}`)
    check('the raw marker no longer appears as a substring',
      wire.split(marker).length - 1, 0)
    check('messages, tool arguments, tool results, and tool declarations are covered',
      wire.split(defused).length - 1, 4)
  } finally {
    mod.__clearCatalogs()
    server.close()
    mod.__deleteLlama('media-test')
    installLive()
  }
}

// --- 1e''. in-history system updates stay llama.cpp-compatible --------------
// The harness may append a system update after the conversation starts and
// before the next user turn. A raw mid-history system message makes llama.cpp's
// Jinja templates raise, and a separate user message breaks templates that
// require strict user/assistant alternation, so fold the update into that user.
console.log('\n-- in-history system updates --')
{
  const messages = await mod.toOpenAiMessages({}, {
    provider: 'p',
    model: 'm',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'lead' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'system', content: [{ type: 'text', text: 'update' }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ],
  })
  check('the leading system stays a system message', messages[0], { role: 'system', content: 'lead' })
  check('a later system update is folded into the next user turn', messages[3], { role: 'user', content: 'update\n\nnext' })
  check('no extra user turn is introduced', messages.map((m) => m.role), ['system', 'user', 'assistant', 'user'])

  const leading = await mod.toOpenAiMessages({}, {
    provider: 'p',
    model: 'm',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'lead' }] },
      { role: 'system', content: [{ type: 'text', text: 'more' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
  })
  check('leading system updates are merged into one system message', leading[0], { role: 'system', content: 'lead\n\nmore' })

  const noSystemRole = await mod.toOpenAiMessages({}, {
    provider: 'p',
    model: 'm',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'lead' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
  }, false)
  check('a template without system support gets one folded user turn', noSystemRole.map((m) => m.role), ['user'])
  check('the folded system content precedes the user text', noSystemRole[0].content, 'lead\n\nhi')
}

// --- 1e2. the real runtime integrates an in-history system update -----------
// The conversion unit test above checks the message shape; this drives the
// descriptor and request path through LlmRuntime as well.
console.log('\n-- runtime in-history system update --')
{
  const checkout = findCheckout()
  if (checkout === undefined) {
    skip('runtime in-history system update (no dsh checkout)')
  } else {
    const { createServer } = await import('node:http')
    let captured = null
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        try { captured = JSON.parse(raw) } catch { captured = null }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n'
          + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
          + 'data: [DONE]\n\n')
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    try {
      mod.__setLlama({ provider: 'system-runtime', baseURL: origin + '/v1', origin, apiKeyEnv: null })
      mod.__clearCatalogs()
      mod.__setCatalog(origin, {
        at: Date.now(), ttlMs: 60_000, models: [{ id: 'm', name: 'm', input: ['text'] }],
        contextWindow: 4096, contextSource: 'props', defaultMaxTokens: null, totalSlots: 1, systemRole: true,
      })
      const llm = await import(pathToFileURL(join(checkout, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')).href)
      const { default: LlmRuntime, createAssistantMessage, createSystemMessage, createUserMessage } = llm
      const { Context } = await import(pathToFileURL(join(checkout, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)
      const ctx = new Context()
      const runtime = new LlmRuntime(ctx)
      ctx.llm = runtime
      runtime.registerAdapter(['system-runtime'], mod.createLlamaAdapter(ctx))
      const user = (text) => createUserMessage({ content: [{ type: 'text', text }] })
      for await (const chunk of runtime.stream({
        provider: 'system-runtime', model: 'm', sessionId: 'system-session',
        messages: [
          createSystemMessage('lead'),
          user('hi'),
          createAssistantMessage({ provider: 'system-runtime', model: 'm', content: [{ type: 'text', text: 'hello' }] }),
          createSystemMessage('update'),
          user('next'),
        ],
      })) void chunk
      check('runtime sends one leading system message', captured?.messages?.[0], { role: 'system', content: 'lead' })
      check('runtime folds the later system update into the next user turn', captured?.messages?.[3], { role: 'user', content: 'update\n\nnext' })
      check('runtime introduces no mid-history system message', captured?.messages?.map((message) => message.role), ['system', 'user', 'assistant', 'user'])
    } finally {
      mod.__clearCatalogs()
      server.close()
    }
  }
}

// --- 1e3. concurrent sessions keep their own llama.cpp slot -----------------
// llama.cpp otherwise selects an unpinned request's slot by prompt similarity,
// and sessions sharing a system prompt can steal each other's KV cache.
console.log('\n-- session slot affinity --')
{
  const { createServer } = await import('node:http')
  let captured = null
  let capturedAgent = null
  const server = createServer((req, res) => {
    capturedAgent = req.headers['user-agent'] ?? null
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try { captured = JSON.parse(raw) } catch { captured = null }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  mod.__setLlama({ provider: 'slot-test', baseURL: origin + '/v1', origin, apiKeyEnv: null })
  mod.__clearCatalogs()
  mod.__setCatalog(origin, {
    at: Date.now(), ttlMs: 60_000, models: [{ id: 'm', name: 'm', input: ['text'] }],
    contextWindow: 4096, contextSource: 'props', defaultMaxTokens: null, totalSlots: 6, systemRole: true,
  })
  const run = async (sessionId, purpose) => {
    captured = null
    for await (const chunk of mod.llamaStream({ attachments: {} }, {
      provider: 'slot-test', model: 'm', sessionId, purpose,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) void chunk
    return captured?.id_slot
  }
  try {
    check('the first session is pinned to slot 0', await run('sess-a'), 0)
    check('the plugin sends its versioned user-agent', capturedAgent, `dsh-llm-llamacpp ${packageVersion}`)
    check('a second session is pinned to a different slot', await run('sess-b'), 1)
    check('the first session keeps its slot', await run('sess-a'), 0)
    check('the second session keeps its slot', await run('sess-b'), 1)
    check('compaction reuses the conversation slot', await run('sess-a', 'compaction'), 0)
    check('a session-title call uses a free slot', await run('sess-a', 'session-title'), 2)
    check('a request without a session is not pinned', await run(undefined), undefined)
    for (const session of ['sess-c', 'sess-d', 'sess-e', 'sess-f']) await run(session)
    const fake = (session) => mod.__progress().set('fake-' + session, {
      endedAt: null, provider: 'slot-test', sessionId: session, updatedAt: Date.now(),
    })
    fake('sess-c')
    try {
      // The idle conversations are sess-a and sess-b; either may be the LRU
      // depending on whether compaction refreshed sess-a's lastSeen. What matters
      // is that the active sub-agent's slot is not taken.
      const reused = await run('sess-g')
      check('an idle conversation is reused for the new session', [0, 1].includes(reused), true)
      check('the active sub-agent still has its slot', await run('sess-c'), 2)
      for (const session of ['sess-a', 'sess-b', 'sess-d', 'sess-e', 'sess-f', 'sess-g']) fake(session)
      check('a new session is unpinned when every slot is active', await run('sess-h'), undefined)
    } finally {
      for (const session of ['sess-a', 'sess-b', 'sess-c', 'sess-d', 'sess-e', 'sess-f', 'sess-g']) {
        mod.__progress().delete('fake-' + session)
      }
    }
  } finally {
    mod.__clearCatalogs()
    server.close()
  }
}

// --- 1e''. a defaulted effort inherits the session's routed effort --------
// llama.cpp renders reasoning_effort into the chat template. Any call that
// leaves effort at the model default (compaction, titles, other one-shots) must
// use the conversation's effort so the prefix and its KV cache stay identical.
// An explicit non-default effort is the caller's choice and is preserved.
console.log('\n-- session effort fallback --')
{
  const { createServer } = await import('node:http')
  let captured = null
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try { captured = JSON.parse(raw) } catch { captured = null }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const effortOrigin = `http://127.0.0.1:${server.address().port}`
  mod.__setLlama({ provider: 'effort-test', baseURL: effortOrigin + '/v1', origin: effortOrigin, apiKeyEnv: null })
  mod.__setEffortCatalog(effortOrigin, {
    mode: 'standard',
    levels: new Set(['none', 'low', 'medium', 'high']),
    defaultLevel: 'medium',
    offValue: 'none',
  })
  const sessionWith = (config) => ({ requestHeader: () => ({ config }) })
  const ctxWith = (session) => ({
    attachments: {},
    get: (name) => name === 'sessions' ? { get: (id) => id === 'sess-1' ? session : undefined } : undefined,
  })
  const run = async (ctx, options) => {
    captured = null
    for await (const chunk of mod.llamaStream(ctx, {
      provider: 'effort-test',
      model: 'm',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      ...options,
    })) void chunk
    return captured?.reasoning_effort ?? null
  }
  try {
    check('a main request sends its selected effort',
      await run(ctxWith(sessionWith({ provider: 'effort-test', model: 'm', reasoningEffort: 'low' })), { reasoningEffort: 'low' }),
      'low')
    check('a defaulted compaction effort inherits the session effort',
      await run(ctxWith(sessionWith({ provider: 'effort-test', model: 'm', reasoningEffort: 'low' })), { reasoningEffort: 'medium', purpose: 'compaction' }),
      'low')
    check('a defaulted title effort inherits the same session effort',
      await run(ctxWith(sessionWith({ provider: 'effort-test', model: 'm', reasoningEffort: 'low' })), { reasoningEffort: 'medium', purpose: 'session-title' }),
      'low')
    check('an explicit non-default compaction effort is preserved',
      await run(ctxWith(sessionWith({ provider: 'effort-test', model: 'm', reasoningEffort: 'low' })), { reasoningEffort: 'high', purpose: 'compaction' }),
      'high')
    check('an explicit non-default title effort is preserved',
      await run(ctxWith(sessionWith({ provider: 'effort-test', model: 'm', reasoningEffort: 'low' })), { reasoningEffort: 'high', purpose: 'session-title' }),
      'high')
    check('a different route keeps its own effort',
      await run(ctxWith(sessionWith({ provider: 'other-provider', model: 'm', reasoningEffort: 'low' })), { reasoningEffort: 'medium', purpose: 'compaction' }),
      'medium')
    check('a call without a session keeps its supplied effort',
      await run({ attachments: {} }, { reasoningEffort: 'medium', purpose: 'compaction' }),
      'medium')
    check('a session with no routed effort keeps its supplied effort',
      await run(ctxWith(sessionWith({ provider: 'effort-test', model: 'm' })), { reasoningEffort: 'medium', purpose: 'compaction' }),
      'medium')
  } finally {
    server.close()
    mod.__deleteLlama('effort-test')
    installLive()
  }
}

// --- 1e'''. interleaved parallel tool calls keep their own blocks ---------
// OpenAI streams tool calls by `index`; fragments for call 1 can arrive between
// fragments for call 0. Closing the previous block on every switch turns two
// calls into several incomplete ones with the wrong arguments.
console.log('\n-- interleaved parallel tool calls --')
{
  const { createServer } = await import('node:http')
  const frame = (delta, finish = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const body = [
    frame({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"p":' } }] }),
    frame({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'write', arguments: '{"q":' } }] }),
    frame({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }),
    frame({ tool_calls: [{ index: 1, function: { arguments: '"b"}' } }] }),
    frame({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ].join('')
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const parallelOrigin = `http://127.0.0.1:${server.address().port}`
  mod.__setLlama({ provider: 'parallel-test', baseURL: parallelOrigin + '/v1', origin: parallelOrigin, apiKeyEnv: null })
  const chunks = []
  try {
    for await (const chunk of mod.llamaStream({ attachments: {} }, {
      provider: 'parallel-test',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'two calls' }] }],
    })) chunks.push(chunk)
  } finally {
    server.close()
    mod.__deleteLlama('parallel-test')
    installLive()
  }
  const starts = chunks.filter((chunk) => chunk.type === 'block-start' && chunk.blockType === 'tool-call')
  const ends = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  const finish = chunks.find((chunk) => chunk.type === 'finish')?.reason
  check('two interleaved calls open exactly two blocks', starts.length, 2)
  check('each interleaved call keeps its id and name',
    ends.map(({ block }) => [block.id, block.name]),
    [['call_a', 'read'], ['call_b', 'write']])
  check('each interleaved call keeps all of its arguments',
    ends.map(({ block }) => block.arguments),
    ['{"p":"a"}', '{"q":"b"}'])
  check('the interleaved turn finishes as tool-calls', finish?.kind, 'tool-calls')
}

// --- 1f. the dialog reads the server only while it is open ---------------
// `/metrics` and `/slots` must cost the llama.cpp server nothing while nobody
// is looking at the dialog: the pill's payload carries the cached verdict and
// this session's SSE progress, and `live=1` is what buys the raw readings.
console.log('\n-- dialog gating --')
{
  // The handler resolves the endpoint from the configured route, not from a
  // config scan, so it needs no config services at all.
  const handlerCtx = { attachments: {} }
  const handler = mod.createLiveHandler(handlerCtx, { pollMs: 500 })
  const capture = async (query) => {
    let body = null
    const res = { writeHead() {}, end(text) { body = JSON.parse(text) } }
    await handler({ method: 'GET', url: `/llamacpp-metrics/live?${query}` }, res)
    return body
  }
  const query = `provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = (url, init) => { seen.push(String(url)); return realFetch(url, init) }
  try {
    const readings = () => seen.filter(u => u.endsWith('/metrics') || u.endsWith('/slots')).length
    // Prime the verdict (probe) and the dialog path together.
    const open = await capture(`${query}&retry=1&live=1`)
    check('an open dialog reads the server', readings() > 0, true)
    check('an open dialog is marked live', open.live, true)
    check('an open dialog carries metrics', typeof open.metrics, 'object')
    check('an open dialog carries slots', 'slots' in open, true)
    check('an open dialog carries one row per slot', Array.isArray(open.slots?.rows), true)
    check('an open dialog carries no raw slots dump', open.debug?.slotsRaw, undefined)
    check('an open dialog marks the server reachable', open.online, true)

    seen.length = 0
    const light = await capture(query)
    check('a closed dialog polls neither /metrics nor /slots', readings(), 0)
    check('a closed dialog is not marked live', light.live, false)
    check('a closed dialog still answers the pill', light.state, 'llama')
    check('a closed dialog still marks the server reachable', light.online, true)
    check('a closed dialog still carries progress', Array.isArray(light.progressLive), true)
    check('a closed dialog still carries the verdict', typeof light.props, 'object')
    check('a closed dialog carries no metrics', light.metrics, undefined)
    check('a closed dialog carries no slots', light.slots, undefined)
    check('a closed dialog still sets the poll interval', light.pollMs, 500)
  } finally {
    globalThis.fetch = realFetch
  }
}

// --- 1f'. missing readings are not an offline server ----------------------
// A llama.cpp started without --metrics (the default) still has /slots, and a
// build started with --no-slots still has /props. Neither missing endpoint may
// turn the confirmed origin into "unreachable".
console.log('\n-- live readings without metrics or slots --')
{
  const { createServer } = await import('node:http')
  const flags = { metrics: false, slots: true, metricsCalls: 0, failLiveMetrics: false }
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    if (path === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ total_slots: 1, build_info: 'test', model: 'flags-model' }))
      return
    }
    if (path === '/metrics' && flags.metrics) {
      flags.metricsCalls += 1
      if (flags.failLiveMetrics && flags.metricsCalls > 1) {
        res.writeHead(500)
        res.end('scrape failed')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('llamacpp:tokens_predicted_total 10\nllamacpp:tokens_predicted_seconds_total 2\n')
      return
    }
    if (path === '/slots' && flags.slots) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ id: 0, n_ctx: 8192, is_processing: false, n_prompt_tokens: 12 }]))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  mod.__setLlama({ provider: 'flags', alias: 'flags', baseURL: origin + '/v1', origin, apiKeyEnv: null })
  const handler = mod.createLiveHandler({ attachments: {} }, { pollMs: 500 })
  const capture = async (live) => {
    let body = null
    const res = { writeHead() {}, end(text) { body = JSON.parse(text) } }
    await handler({
      method: 'GET',
      url: `/llamacpp-metrics/live?provider=flags&model=flags-model&retry=1${live ? '&live=1' : ''}`,
    }, res)
    return body
  }
  try {
    const metricsOff = await capture(true)
    check('metrics off keeps the server online', metricsOff.online, true)
    check('metrics off reports metrics disabled', metricsOff.metricsEnabled, false)
    check('metrics off carries a null reading', metricsOff.metrics, null)
    check('metrics off still returns slots', metricsOff.slots?.total, 1)
    check('metrics off still returns SSE progress', Array.isArray(metricsOff.progressLive), true)

    flags.slots = false
    const light = await capture(false)
    check('no readings still leaves the light poll online', [light.online, light.state], [true, 'llama'])
    const noReadings = await capture(true)
    check('no readings still leaves the dialog online', noReadings.online, true)
    check('no readings reports both sources as absent', [noReadings.metrics, noReadings.slots], [null, null])
    check('no readings keeps the pill progress', Array.isArray(noReadings.progressLive), true)

    flags.metrics = true
    flags.failLiveMetrics = true
    flags.metricsCalls = 0
    const failedScrape = await capture(true)
    check('a failed metrics scrape keeps the server online', failedScrape.online, true)
    check('a failed metrics scrape keeps the capability', failedScrape.metricsEnabled, true)
    check('a failed metrics scrape reports no reading', failedScrape.metrics, null)
  } finally {
    mod.__deleteLlama('flags')
    await new Promise((resolve) => server.close(resolve))
  }
}

// --- 1f. availability transitions refresh the model catalog ----------------
// A provider group disappears from the picker when the model list is empty.
// The picker caches that catalog until an invalidation event, so a restart must
// announce itself; these checks cover the host-side transition and cache clear.
console.log('\n-- availability transitions --')
{
  const WATCH = 'http://127.0.0.1:59999'
  const realFetch = globalThis.fetch
  const changes = []
  const handler = mod.createLiveHandler({ attachments: {} }, {
    pollMs: 500,
    onAvailabilityChange: (origin, state) => changes.push([origin, state]),
  })
  const capture = async () => {
    let body = null
    const res = { writeHead() {}, end(text) { body = JSON.parse(text) } }
    await handler({ method: 'GET', url: '/llamacpp-metrics/live?provider=watch&retry=1' }, res)
    return body
  }
  mod.__deleteLlama('watch')
  mod.__setLlama({ provider: 'watch', alias: 'watch', baseURL: WATCH + '/v1', origin: WATCH, apiKeyEnv: null })
  let online = false
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target === WATCH + '/props') {
      if (!online) throw new Error('down')
      return new Response(JSON.stringify({ total_slots: 1, build_info: 'test', model: 'test-model' }), { status: 200 })
    }
    if (target === WATCH + '/metrics') return new Response('llamacpp:requests_processing 1\n', { status: 200 })
    return realFetch(url)
  }
  try {
    const down = await capture()
    check('the first probe does not announce a transition', [down.state, changes.length], ['unreachable', 0])

    mod.__setCatalog(WATCH, { at: Date.now(), ttlMs: 5000, models: [], contextWindow: null, contextSource: null, defaultMaxTokens: null })
    online = true
    const up = await capture()
    check('a server coming online announces once', [up.state, changes], ['llama', [[WATCH, 'llama']]])
    check('the failed catalog is cleared for the refresh', mod.__catalogFor(WATCH), undefined)

    const steady = await capture()
    check('a steady online poll does not announce again', [steady.state, changes.length], ['llama', 1])

    mod.__setCatalog(WATCH, { at: Date.now(), ttlMs: 5000, models: [], contextWindow: null, contextSource: null, defaultMaxTokens: null })
    const retryEmpty = await capture()
    check('an online server with an empty catalog is retried', [retryEmpty.state, changes.length], ['llama', 2])

    mod.__setCatalog(WATCH, { at: Date.now(), ttlMs: 5000, models: [{ id: 'test-model' }], contextWindow: null, contextSource: null, defaultMaxTokens: null })
    online = false
    const offline = await capture()
    check('a server going offline announces once', [offline.state, changes.at(-1)], ['unreachable', [WATCH, 'unreachable']])
    check('the offline catalog is cleared too', mod.__catalogFor(WATCH), undefined)
  } finally {
    globalThis.fetch = realFetch
    mod.__deleteLlama('watch')
  }
}

// --- 1f'. failure paths against a fake llama.cpp server -------------------
// The bug this pins: a request the server failed (OOM here) arrived as
// `data: {"error": {...}}` inside a 200 stream that then closed with no finish
// reason and no `[DONE]`. The frame was dropped, the close was read as a normal
// stop, and the UI reported "Completed" with nothing in it.
console.log('\n-- stream failure paths --')
{
  const { createServer } = await import('node:http')
  const scenarios = {
    ok: { headers: { 'content-type': 'text/event-stream' }, body: 'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' },
    // A failed request: the error frame, then the connection closes.
    failed: { headers: { 'content-type': 'text/event-stream' }, body: 'data: {"error":{"message":"failed to allocate compute buffers","type":"server_error","code":500}}\n\n' },
    // Cut off mid-stream, no error frame at all.
    cut: { headers: { 'content-type': 'text/event-stream' }, body: 'data: {"choices":[{"index":0,"delta":{"content":"par"},"finish_reason":null}]}\n\n' },
    // A completed response with nothing in it.
    empty: { headers: { 'content-type': 'text/event-stream' }, body: 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' },
    // A terminal marker without the provider finish reason pi-ai requires.
    doneOnly: { headers: { 'content-type': 'text/event-stream' }, body: 'data: [DONE]\n\n' },
    malformed: { headers: { 'content-type': 'text/event-stream' }, body: 'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {not-json}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' },
    // Provider terminal states that are not a successful stop.
    filtered: { headers: { 'content-type': 'text/event-stream' }, body: 'data: {"choices":[{"index":0,"delta":{"content":"blocked"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n\n' },
    unknownFinish: { headers: { 'content-type': 'text/event-stream' }, body: 'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"new_state"}]}\n\ndata: [DONE]\n\n' },
    // A 408 is classified by its body text, like pi-ai.
    timeoutStatus: { status: 408, headers: { 'content-type': 'text/plain' }, body: 'Request Timeout' },
    empty408: { status: 408, headers: { 'content-type': 'text/plain' }, body: '' },
    unknownStatus: { status: 409, headers: { 'content-type': 'text/plain' }, body: 'Conflict' },
    // A refusal: llama.cpp's JSON envelope on a non-200, also seen on a proxy.
    refused: { status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":{"message":"the prompt is too long","type":"invalid_request_error","code":400}}' },
    // A 200 that is not SSE at all.
    junk: { headers: { 'content-type': 'text/html' }, body: '<html>502 Bad Gateway</html>' },
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const model = (() => { try { return JSON.parse(raw).model } catch { return 'ok' } })()
      if (model === 'hang') return // accepted, but never sends response headers
      if (model === 'stalledError') {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.write('partial error body')
        return // headers sent, body never ends
      }
      const scenario = scenarios[model] ?? scenarios.ok
      res.writeHead(scenario.status ?? 200, scenario.headers)
      res.end(scenario.body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  mod.__setLlama({ provider: 'fake', baseURL: origin + '/v1', origin, apiKeyEnv: null })
  const runFake = async (model) => {
    const chunks = []
    try {
      for await (const chunk of mod.llamaStream({ attachments: {} }, { provider: 'fake', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
        chunks.push(chunk)
      }
      return { chunks, error: null }
    } catch (error) {
      return { chunks, error }
    }
  }

  const good = await runFake('ok')
  check('a healthy stream still finishes', [good.error, good.chunks.filter(c => c.type === 'text-delta').length, good.chunks.at(-1)?.reason?.kind], [null, 1, 'stop'])

  mod.__setStreamIdleMs(150)
  const hangStarted = Date.now()
  const hang = await runFake('hang')
  const hangElapsed = Date.now() - hangStarted
  mod.__setStreamIdleMs(300000)
  check('a server that never sends headers times out', [hang.error?.code, hang.error?.message], ['TIMEOUT', 'llama.cpp stream idle timeout after 150ms waiting for response headers'])
  check('the header timeout is bounded', hangElapsed < 2000, true)

  mod.__setStreamIdleMs(150)
  const stalledErrorStarted = Date.now()
  const stalledError = await runFake('stalledError')
  const stalledErrorElapsed = Date.now() - stalledErrorStarted
  mod.__setStreamIdleMs(300000)
  check('a stalled non-200 error body times out', [stalledError.error?.code, stalledError.error?.message], ['TIMEOUT', 'llama.cpp stream idle for 150ms'])
  check('the error-body timeout is bounded', stalledErrorElapsed < 2000, true)

  const failed = await runFake('failed')
  check('a mid-stream error frame is surfaced', failed.error?.message, 'llama.cpp failed the request: failed to allocate compute buffers (server_error)')
  check('and no finish chunk claims success', failed.chunks.some(c => c.type === 'finish'), false)

  const cut = await runFake('cut')
  check('a stream cut without a finish reason fails', cut.error?.message, 'llama.cpp ended the stream without a finish reason')

  const empty = await runFake('empty')
  check('a content-free stop is the harness empty-response error', [empty.error?.code, empty.error?.message], ['EMPTY_RESPONSE', 'llama.cpp model "empty" returned a completed response with no content'])

  const doneOnly = await runFake('doneOnly')
  check('DONE without a finish reason is a transport failure', [doneOnly.error?.code, doneOnly.error?.message], ['TRANSPORT', 'llama.cpp ended the stream without a finish reason'])
  check('DONE without a finish reason emits no finish chunk', doneOnly.chunks.some(c => c.type === 'finish'), false)

  const malformed = await runFake('malformed')
  check('a malformed frame fails instead of being skipped', [malformed.error?.code, malformed.error?.message], ['LLAMA_CPP_ERROR', 'llama.cpp returned malformed server-sent event JSON'])
  check('a malformed frame emits no finish chunk', malformed.chunks.some(c => c.type === 'finish'), false)

  const filtered = await runFake('filtered')
  check('content_filter is a provider error, not a stop', [filtered.error?.code, filtered.error?.message], ['LLAMA_CPP_ERROR', 'llama.cpp finish_reason: content_filter'])
  check('content_filter emits no finish chunk', filtered.chunks.some(c => c.type === 'finish'), false)

  const unknownFinish = await runFake('unknownFinish')
  check('an unknown finish reason is a provider error', [unknownFinish.error?.code, unknownFinish.error?.message], ['LLAMA_CPP_ERROR', 'llama.cpp finish_reason: new_state'])
  check('an unknown finish reason emits no finish chunk', unknownFinish.chunks.some(c => c.type === 'finish'), false)

  const refused = await runFake('refused')
  check('a non-200 reads the server reason out of the envelope', refused.error?.message, 'llama.cpp refused the request (HTTP 500): the prompt is too long (invalid_request_error)')

  const timeoutStatus = await runFake('timeoutStatus')
  check('a 408 with timeout text is TIMEOUT', [timeoutStatus.error?.code, timeoutStatus.error?.message], ['TIMEOUT', 'llama.cpp refused the request (HTTP 408): Request Timeout'])

  const empty408 = await runFake('empty408')
  check('an empty 408 is still a timeout', [empty408.error?.code, String(empty408.error?.message).startsWith('llama.cpp refused the request (HTTP 408)')], ['TIMEOUT', true])

  const unknownStatus = await runFake('unknownStatus')
  check('an unclassified status uses the plugin error code', [unknownStatus.error?.code, String(unknownStatus.error?.message).startsWith('llama.cpp refused the request (HTTP 409)')], ['LLAMA_CPP_ERROR', true])

  const junk = await runFake('junk')
  check('a non-SSE body is reported with its text', junk.error?.message, 'llama.cpp returned no stream at all: <html>502 Bad Gateway</html>')

  check('no failed request is left looking live',
    [...mod.__progress().values()].every((entry) => typeof entry.endedAt === 'number'),
    true)
  check('and a mid-stream failure kept its reason', [...mod.__progress().values()].some((entry) => entry.outcome === 'failed'), true)
  clearProgress()
  mod.__clearCatalogs()
  installLive()
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

// --- 1f''. SSE framing robustness -----------------------------------------
// A body arrives in socket-sized pieces, so a frame can be cut anywhere: inside
// its JSON, inside a multi-byte character. The parser must reassemble frames,
// honour CRLF, ignore keep-alive comment pings and join multi-line data.
console.log('\n-- SSE framing --')
{
  clearProgress()
  check('a complete frame is returned and the partial stays',
    mod.takeSsePayloads('data: {"a":1}\n\ndata: {"b"'),
    { payloads: ['{"a":1}'], rest: 'data: {"b"' })
  check('the retained tail completes once its terminator arrives',
    mod.takeSsePayloads('data: {"b":2}\n\n').payloads, ['{"b":2}'])
  check('comment pings and blank lines parse to nothing',
    mod.takeSsePayloads(':\n\n\n\n').payloads, [])
  check('multi-line data joins with a newline',
    mod.takeSsePayloads('data: one\ndata: two\n\n').payloads, ['one\ntwo'])
  check('CRLF frames parse', mod.takeSsePayloads('data: {"a":1}\r\n\r\n').payloads, ['{"a":1}'])
  check('only one leading space is stripped',
    mod.takeSsePayloads('data:  two\n\n').payloads, [' two'])
  check('an unterminated frame is never dispatched',
    mod.takeSsePayloads('data: {"a":1}\n').payloads, [])

  const { createServer } = await import('node:http')
  const contentFrame = (text) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
  const stopFrame = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  const bodies = {
    // Cut every 7 bytes, so frames break mid-JSON.
    split: { body: contentFrame('ab') + stopFrame, step: 7 },
    // Byte by byte, including a multi-byte character split across writes.
    multibyte: { body: contentFrame('héllo 🙂') + stopFrame, step: 1 },
    crlf: { body: (contentFrame('c') + stopFrame).replace(/\n/g, '\r\n'), step: 0 },
    // A keep-alive comment frame in the middle of the stream.
    ping: { body: contentFrame('d') + ':\n\n' + stopFrame, step: 0 },
    // One event whose data spans three `data:` lines (legal SSE).
    multiline: { body: 'data: {"choices":[{"index":0,"delta":\ndata: {"content":"e"},\ndata: "finish_reason":null}]}\n\n' + stopFrame, step: 0 },
    // Content, then a mid-stream error frame.
    contentThenError: { body: contentFrame('par'), step: 0, then: 'data: {"error":{"message":"boom","type":"server_error"}}\n\n' },
    // A frame truncated mid-JSON with the error frame glued onto the same line:
    // unrecoverable as two frames, but the reason must still be visible.
    glued: { body: 'data: {"choices":[{"index":0,"delta":{"cont', step: 0, then: 'data: {"error":{"message":"boom","type":"server_error"}}\n\n' },
    // Nothing further is ever sent: only an abort ends this one.
    stall: { body: contentFrame('x'), step: 0, stall: true },
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const model = (() => { try { return JSON.parse(raw).model } catch { return 'split' } })()
      const scenario = bodies[model] ?? bodies.split
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const first = Buffer.from(scenario.body)
      if (scenario.step > 0) {
        // Deliberately unaligned with any frame or character boundary.
        let at = 0
        const timer = setInterval(() => {
          if (at >= first.length) {
            clearInterval(timer)
            if (scenario.then !== undefined) res.write(scenario.then)
            if (scenario.stall !== true) res.end()
            return
          }
          res.write(first.subarray(at, at + scenario.step))
          at += scenario.step
        }, 1)
        res.on('close', () => clearInterval(timer))
        return
      }
      res.write(first)
      if (scenario.then !== undefined) res.write(scenario.then)
      if (scenario.stall !== true) res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  mod.__setLlama({ provider: 'fake', baseURL: origin + '/v1', origin, apiKeyEnv: null })
  const readText = async (model, signal) => {
    const chunks = []
    try {
      for await (const chunk of mod.llamaStream({ attachments: {} }, { provider: 'fake', model, signal, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
        chunks.push(chunk)
      }
      return { chunks, error: null }
    } catch (error) {
      return { chunks, error }
    }
  }
  const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const finishOf = (chunks) => chunks.at(-1)?.reason?.kind

  const split = await readText('split')
  check('frames cut mid-JSON are reassembled', [textOf(split.chunks), finishOf(split.chunks)], ['ab', 'stop'])
  const multibyte = await readText('multibyte')
  check('a multi-byte character split across reads survives', textOf(multibyte.chunks), 'héllo 🙂')
  const crlf = await readText('crlf')
  check('CRLF framing parses', [textOf(crlf.chunks), finishOf(crlf.chunks)], ['c', 'stop'])
  const ping = await readText('ping')
  check('a keep-alive comment frame is ignored', [textOf(ping.chunks), finishOf(ping.chunks)], ['d', 'stop'])
  const multiline = await readText('multiline')
  check('multi-line data is joined before parsing', textOf(multiline.chunks), 'e')
  const contentThenError = await readText('contentThenError')
  check('content before a mid-stream error is delivered, then the error surfaces',
    [textOf(contentThenError.chunks), contentThenError.error?.message],
    ['par', 'llama.cpp failed the request: boom (server_error)'])
  const glued = await readText('glued')
  check('a truncated line glued to an error frame still quotes the reason',
    typeof glued.error?.message === 'string' && glued.error.message.includes('boom'), true)

  const controller = new AbortController()
  const stalled = readText('stall', controller.signal)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const inflight = [...mod.__progress().values()].find((entry) => entry.endedAt === null)
  check('the stalled stream is still open before the abort', inflight !== undefined, true)
  controller.abort()
  const stopped = await stalled
  check('an abort ends as an aborted finish, not a broken stream', [stopped.error, finishOf(stopped.chunks)], [null, 'aborted'])
  const stoppedEntry = [...mod.__progress().values()].find((entry) => entry.id === inflight.id)
  check('an aborted request is held, saying it was stopped', [typeof stoppedEntry.endedAt === 'number', stoppedEntry.outcome], [true, 'aborted'])
  clearProgress()

  mod.__clearCatalogs()
  installLive()
  await new Promise((resolve) => server.close(resolve))
}

// --- 1f2. the Live table's payload ----------------------------------------
// The dialog names the task each in-flight request belongs to, so the host reads
// a session's own projections while the request is still in flight. Offline,
// against a fake server, so the naming rules hold without a llama.cpp.
console.log('\n-- live payload fields --')
{
  const { createServer } = await import('node:http')
  const body = [
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }], timings: { predicted_n: 7, predicted_per_second: 42.5 } }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n',
    'data: [DONE]\n\n',
  ].join('')
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body) })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  mod.__setLlama({ provider: 'fake', baseURL: origin + '/v1', origin, apiKeyEnv: null })

  // Sample the entry WHILE it is in flight: it is deleted when the stream ends.
  const run = async (ctx, options) => {
    const seen = []
    for await (const chunk of mod.llamaStream(ctx, options)) {
      void chunk
      if (mod.__progress().size > 0) {
        mod.labelProgress(ctx)
        seen.push(...mod.__progress().values())
      }
    }
    return seen
  }
  const request = (over = {}) => ({
    provider: 'fake', model: 'm', sessionId: 'child-1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], ...over,
  })
  // One key per read, so each stub answers for exactly the key it was asked.
  const services = (values) => ({
    sessions: { get: (id) => (id === 'child-1' ? { id } : undefined) },
    sessionProjections: {
      cachedSnapshot: (_session, keys) => (values[keys[0]] === undefined ? undefined : { values: { [keys[0]]: values[keys[0]] } }),
    },
  })
  const ctxWith = (registry) => ({ attachments: {}, get: (name) => registry[name] })

  const subagent = await run(ctxWith(services({ subagent: { mode: 'one-shot', label: 'Research SSE parser' } })), request({ purpose: 'session-title' }))
  const named = subagent.at(-1)
  check('a sub-agent row is named by its own descriptor label', [named.sessionKind, named.sessionLabel], ['subagent', 'Research SSE parser'])
  check('an auxiliary call keeps its purpose', named.purpose, 'session-title')
  check('the request counts its own generated tokens', named.decoded, 7)
  check('the entry carries a stable row key', typeof named.id === 'string' && named.id.startsWith('fake|child-1|'), true)

  const titled = await run(ctxWith(services({ title: 'Rework the live table' })), request())
  check('without a descriptor the session title names the row', [titled.at(-1).sessionKind, titled.at(-1).sessionLabel], ['session', 'Rework the live table'])

  const plain = await run({ attachments: {} }, request())
  check('no services means no name, never a failure', [plain.at(-1).sessionKind, plain.at(-1).sessionLabel], [null, null])

  const broken = await run(ctxWith({ sessions: { get: () => { throw new Error('no store') } } }), request())
  check('a throwing service cannot touch the request', broken.at(-1).sessionLabel, null)

  const unknown = await run(ctxWith(services({ subagent: { mode: 'one-shot' } })), request())
  check('a descriptor with no label names nothing', unknown.at(-1).sessionLabel, null)

  mod.__clearCatalogs()
  installLive()
  await new Promise((resolve) => server.close(resolve))
}

// --- 1f4. the All-metrics derivation --------------------------------------
// One scrape of this build's /metrics, so the curated numbers the dialog shows
// are pinned to real sample names and to the units llama.cpp actually uses.
console.log('\n-- metrics derivation --')
const METRICS_FIXTURE = [
  '# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed',
  '# TYPE llamacpp:prompt_tokens_total counter',
  'llamacpp:prompt_tokens_total 313402',
  'llamacpp:prompt_tokens_cached_total 1.84294e+06',
  'llamacpp:prompt_seconds_total 958.908',
  'llamacpp:tokens_predicted_total 39556',
  'llamacpp:tokens_predicted_seconds_total 4304.47',
  'llamacpp:n_decode_total 5108',
  'llamacpp:n_tokens_max 64187',
  'llamacpp:spec_decode_num_draft_tokens_total 41179',
  'llamacpp:spec_decode_num_accepted_tokens_total 25745',
  'llamacpp:spec_decode_num_drafts_total 13728',
  'llamacpp:prompt_tokens_seconds 321.169',
  'llamacpp:predicted_tokens_seconds 3.25981',
  'llamacpp:requests_processing 5',
  'llamacpp:requests_deferred 0',
  'llamacpp:n_busy_slots_per_decode 2.81226',
  'llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="0"} 10657',
  'llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="1"} 8391',
  'llamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="2"} 6697',
].join('\n')

{
  const scraped = mod.parseMetrics(METRICS_FIXTURE)
  check('comment lines are skipped and series counted', [scraped.rawTotal, scraped.raw.length], [18, 18])
  // Labeled series fold into one sum, which is why the count cannot come from it.
  check('labeled series fold together', scraped.sums.get('llamacpp:spec_decode_num_accepted_tokens_per_pos_total'), 10657 + 8391 + 6697)
  check('every line is forwarded to the dialog', scraped.raw.some((sample) => sample.labels === 'position="1"'), true)

  const derived = mod.deriveMetrics('http://metrics-test', scraped.sums, scraped.raw, scraped.rawTotal, 1_000_000)
  check('generated tokens are totaled', derived.predictedTotal, 39556)
  check('prompt tokens separate new from reused', [derived.promptTotal, derived.cachedPromptTotal], [313402, 1842940])
  check('the cache share is cumulative', derived.cacheHitPercent, 85.5)
  check('decode seconds are carried for the rate', derived.decodeSecondsTotal, 4304.47)
  check('prompt seconds are carried for the rate', derived.promptSecondsTotal, 958.908)
  // llama.cpp's `predicted_tokens_seconds` counts STEPS, so a cold sample window
  // must fall back to the counters' own ratio (39,556 / 4,304.47 = 9.2 tok/s),
  // never to that gauge's 3.26.
  check('a cold window answers in tokens per decode second', derived.decodeTps, 9.2)
  check('the prompt gauge is already tokens per second', derived.promptTps, 321.169)
  check('load gauges are carried', [derived.requestsProcessing, derived.requestsDeferred, derived.nBusySlotsPerDecode], [5, 0, 2.81226])
  check('speculation is carried with a denominator', [derived.specAcceptPercent, derived.specAcceptedTokens, derived.specDraftSteps], [62.5, 25745, 13728])
  check('the largest sequence is carried, not a batch size', derived.nTokensMax, 64187)
  check('the raw samples travel with their count', [derived.rawTotal, derived.raw.length], [18, 18])

  // A warm window turns the same counters into a delta rate: +2000 tokens over
  // +10 s of decoding, which must beat the cumulative 9.2.
  const warm = mod.parseMetrics('llamacpp:tokens_predicted_total 41556\nllamacpp:tokens_predicted_seconds_total 4314.47\nllamacpp:prompt_tokens_total 313402\nllamacpp:prompt_seconds_total 958.908\n')
  const delta = mod.deriveMetrics('http://metrics-test', warm.sums, warm.raw, warm.rawTotal, 1_010_000)
  check('a warm window reports the observed rate', delta.decodeTps, 200)
  check('and keeps the cumulative totals', [delta.predictedTotal, delta.decodeSecondsTotal], [41556, 4314.47])

  check('metrics off yields no object', mod.deriveMetrics('http://metrics-test', null, [], 0, 1_000_000), null)
  const foreign = mod.parseMetrics('some_other_server_tokens_total 5\n')
  const unknown = mod.deriveMetrics('http://metrics-foreign', foreign.sums, foreign.raw, foreign.rawTotal, 1_000_000)
  check('an unknown build reports nothing rather than zero', [unknown.decodeTps, unknown.promptTps, unknown.cacheHitPercent, unknown.nTokensMax], [null, null, null, null])
  check('but its samples are still forwarded', unknown.rawTotal, 1)

  const many = mod.parseMetrics(Array.from({ length: 250 }, (_, i) => `llamacpp:series_${i}_total ${i}`).join('\n'))
  check('the forwarded list is capped, the count is not', [many.raw.length, many.rawTotal], [240, 250])
}

// --- 1f5. a request's row outlives it -------------------------------------
// A task that takes several turns (every sub-agent) has no request in flight
// while it runs a tool, so deleting the entry at the end of each stream made its
// row blink out of the dialog and return as a different row in a different place.
console.log('\n-- held rows --')
{
  const { createServer } = await import('node:http')
  const body = 'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}],"timings":{"predicted_n":3}}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body) })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  mod.__setLlama({ provider: 'hold', baseURL: origin + '/v1', origin, apiKeyEnv: null })
  // The entry of THIS turn, which is the live one while it streams.
  const turn = async () => {
    const seen = []
    for await (const chunk of mod.llamaStream({ attachments: {} }, {
      provider: 'hold', model: 'm', sessionId: 'child-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      void chunk
      const live = [...mod.__progress().values()].find((entry) => entry.endedAt === null && entry.sessionId === 'child-1')
      if (live !== undefined) seen.push({ ...live })
    }
    return seen[0]
  }

  clearProgress()
  const oneLive = await turn()
  const one = [...mod.__progress().values()].find((entry) => entry.id === oneLive.id)
  const held = [...mod.__liveProgress()].filter((entry) => entry.sessionId === 'child-1')
  check('a finished request is held, not deleted', [typeof one.endedAt === 'number', one.outcome, held.length], [true, 'done', 1])
  // Sessions are remembered so the next turn keeps the row where it was.
  const twoLive = await turn()
  const two = [...mod.__progress().values()].find((entry) => entry.id === twoLive.id)
  check('the session remembers when the task was first seen', two.taskStartedAt, one.taskStartedAt)
  check('and the next turn is a different request', two.id !== one.id, true)
  // The hold is a window, not a leak: once it passes, the entries are dropped.
  for (const entry of mod.__progress().values()) entry.endedAt = Date.now() - 5001
  check('the hold expires', mod.__liveProgress().length, 0)

  // A failed request says so, so the held row is not read as a success.
  const failing = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"boom","type":"server_error"}}') })
  })
  await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve))
  const bad = `http://127.0.0.1:${failing.address().port}`
  mod.__setLlama({ provider: 'hold', baseURL: bad + '/v1', origin: bad, apiKeyEnv: null })
  try { await turn() } catch { /* the stream fails, which is the point */ }
  check('a refused request leaves nothing behind', mod.__liveProgress().length, 0)
  clearProgress()

  mod.__clearCatalogs()
  installLive()
  await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve) => failing.close(resolve))
}

// --- 1g. the /slots table rows -------------------------------------------
// Only fields the running build actually returns are read. The summary reports
// RETAINED context (`n_prompt_tokens`), not the cached-prefix counters llama.cpp
// zeroes when the next task launches.
console.log('\n-- slots rows --')
{
  const slotsBody = [
    { id: 0, n_ctx: 262144, speculative: true, is_processing: true, id_task: 7,
      n_prompt_tokens: 1200, n_prompt_tokens_processed: 300, n_prompt_tokens_cache: 900,
      next_token: [{ has_next_token: true, has_new_line: false, n_remain: 500, n_decoded: 0 }] },
    { id: 1, n_ctx: 262144, speculative: true, is_processing: true, id_task: 8,
      n_prompt_tokens: 19637, n_prompt_tokens_processed: 0, n_prompt_tokens_cache: 0,
      next_token: [{ has_next_token: true, has_new_line: false, n_remain: -1, n_decoded: 128 }] },
    { id: 2, n_ctx: 262144, speculative: false, is_processing: false, id_task: 6,
      n_prompt_tokens: 19637, n_prompt_tokens_processed: 0, n_prompt_tokens_cache: 0,
      next_token: [{ has_next_token: false, has_new_line: false, n_remain: -1, n_decoded: 0 }] },
    { id: 3, n_ctx: 262144, speculative: true, is_processing: false },
  ]
  const slots = mod.normalizeSlots(slotsBody)
  const row = (i) => slots.rows[i]
  check('a prompting slot reports the prompt phase', row(0).phase, 'prompt')
  check('a generating slot reports the decode phase', row(1).phase, 'decode')
  check('a finished slot is idle', row(2).phase, 'idle')
  check('a never-used slot has no context', row(3).ctxLen, null)
  check('a never-used slot keeps its capacity', row(3).nCtx, 262144)
  check('generated tokens are reported', row(1).decoded, 128)
  check('prompt work is reported', [row(0).processed, row(0).cache], [300, 900])
  check('the speculative capability is reported', [row(0).speculative, row(2).speculative], [true, false])
  check('two slots are processing', slots.processing, 2)
  check('the summary sums retained context', slots.ctxTokens, 1200 + 19637 + 19637)
  check('the summary sums slot capacity', slots.ctxMax, 262144 * 4)
  check('the summary carries the context percentage', slots.ctxPercent, 3.9)
  check('no task id survives in a row', 'task' in row(0), false)
  check('an empty /slots body yields null', mod.normalizeSlots([]), null)
}

// --- 1h. per-slot rates from consecutive /slots polls --------------------
// The rate of last resort for a slot whose request this process does not own:
// `/props` exposes no `n_batch`, and the SSE owns the exact per-token timings
// for our own requests.
console.log('\n-- slot rates --')
{
  const origin = 'http://rate-test'
  const sample = (over) => [{ id: 0, active: true, phase: 'prompt', nCtx: 262144, ctxLen: 1000, processed: 500, cache: 0, decoded: 0, ...over }]
  const t0 = 1_000_000
  const first = sample({})
  mod.rateSlots(origin, first, t0)
  check('the first poll has no rate yet', [first[0].promptTps, first[0].decodeTps], [null, null])
  // A slot's context length crawls while its prompt is processed — measured 7 tok/s
  // against a request the same server reported at 350 — so it is not a prompt rate.
  const second = sample({ ctxLen: 1200, processed: 700 })
  mod.rateSlots(origin, second, t0 + 1000)
  check('a prompting slot reports no rate', [second[0].promptTps, second[0].decodeTps], [null, null])
  const third = sample({ ctxLen: 1976, processed: 700, decoded: 40, phase: 'decode' })
  mod.rateSlots(origin, third, t0 + 2000)
  check('the decode rate is the generated growth per second', third[0].decodeTps, 40)
  const restarted = sample({ ctxLen: 500, processed: 0, decoded: 0, phase: 'decode' })
  mod.rateSlots(origin, restarted, t0 + 3000)
  check('a counter reset clears the rates', [restarted[0].promptTps, restarted[0].decodeTps], [null, null])
  mod.rateSlots(origin, sample({ phase: 'decode', decoded: 10 }), t0 + 5000)
  const slow = sample({ phase: 'decode', decoded: 14 })
  mod.rateSlots(origin, slow, t0 + 15000)
  check('a sub-1 tok/s slot keeps a decimal', slow[0].decodeTps, 0.4)
  const late = sample({ phase: 'decode', decoded: 114 })
  mod.rateSlots(origin, late, t0 + 27000)
  check('a stale slot is not given a rate from old samples', late[0].decodeTps, null)
  const stalled = sample({ phase: 'decode', decoded: 14 })
  mod.rateSlots(origin, stalled, t0 + 30000)
  check('a rate expires once nothing moves', stalled[0].decodeTps, null)
}

// --- 1h2. the rates are CURRENT speed, not averages ------------------------
// A reader watches one thing while a request runs: faster or slower NOW. With
// several slots sharing the machine that changes by factors, and the server's own
// `predicted_per_second` is cumulative, so it barely moves. The two failure modes
// to avoid: an unbounded adjacent-frame delta (frames land 1 ms apart) and counting
// the reused prefix as fresh tokens.
console.log('\n-- current speed --')
{
  const { createServer } = await import('node:http')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const chunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`
  const progress = (processed, timeMs) => chunk({
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    prompt_progress: { total: 6000, cache: 1000, processed, time_ms: timeMs },
  })
  const generation = (n, ms) => chunk({
    choices: [{ index: 0, delta: { content: '.' }, finish_reason: null }],
    timings: { predicted_n: n, predicted_ms: ms, predicted_per_second: 1 },
  })
  const frames = [
    progress(2000, 1000), // first frame: nothing to compare against yet
    progress(4000, 2000), // 2000 tok/s over a 1 s batch
    progress(4300, 2400), // 750 tok/s: a slowdown must show up immediately
    progress(6300, 2401), // a 1 ms gap: no rate may be invented from it
    generation(10, 1000), // generation starts, window still too short
    generation(50, 2000), // 40 tok/s over 1 s
    generation(60, 6000), // 4 s for 10 tokens: another slot took the machine
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], timings: { predicted_n: 60, predicted_ms: 6000 } }),
    'data: [DONE]\n\n',
  ]
  const server = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of frames) { res.write(frame); await sleep(60) }
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  mod.__setLlama({ provider: 'speed', baseURL: origin + '/v1', origin, apiKeyEnv: null })
  clearProgress()
  const promptRates = []
  const decodeRates = []
  for await (const chunkValue of mod.llamaStream({ attachments: {} }, {
    provider: 'speed', model: 'm', sessionId: 'speed-1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    void chunkValue
    const entry = [...mod.__progress().values()][0]
    if (entry === undefined) continue
    if (typeof entry.promptTps === 'number') promptRates.push(Math.round(entry.promptTps))
    if (typeof entry.decodeTps === 'number') decodeRates.push(Number(entry.decodeTps.toFixed(1)))
  }
  const unique = (values) => [...new Set(values)]
  // Frames can be read in one batch, so only the latest value of a read is always
  // observable: what matters is that every value is a BATCH rate, not the average.
  check('every prompt rate is a batch rate', unique(promptRates).every((rate) => rate === 2000 || rate === 750), true)
  check('a slowing prompt shows the slow number at once', promptRates[promptRates.length - 1], 750)
  check('a 1 ms frame gap cannot invent a rate', promptRates.every((rate) => rate <= 2000), true)
  // 1 tok/s is the server's cumulative figure used until the window has 400 ms.
  check('the decode rate follows the current speed', unique(decodeRates), [1, 40, 2.5])
  check('a stalled slot reports the slow number, not the old one', decodeRates[decodeRates.length - 1], 2.5)
  check('no sample ring reaches the payload', Object.keys([...mod.__progress().values()][0] ?? {}).some((key) => /sample|window/i.test(key)), false)
  clearProgress()
  mod.__clearCatalogs()
  installLive()
  await new Promise((resolve) => server.close(resolve))
}

// --- 2. reasoning: levels come from the server, with a standard fallback ----
// The harness validates offered levels; the server's template decides them. A
// template that accepts any effort but never enumerates it gets the standard
// off/low/medium/high fallback instead of the old five-level ladder.
console.log('\n-- reasoning effort --')

const QWEN_OFFER = 'Error: Jinja Exception: Unexpected reasoning effort dsh-llm-llamacpp-probe. Supported types are xhigh (default), medium, and low.'
const IFM_OFFER = "Unsupported reasoning_effort: 'dsh-llm-llamacpp-probe'. Supported values: high, medium, low."
const TENCENT_OFFER = 'reasoning_effort error : dsh-llm-llamacpp-probe, should be no_think/low/high'

const qwen = mod.parseEffortOffer(QWEN_OFFER)
check('a "Supported types are" list is parsed', qwen === null ? null : [...qwen.levels].sort(), ['low', 'medium', 'none', 'xhigh'])
check('the server default is parsed', qwen?.defaultLevel, 'xhigh')
check('the off alias defaults to none', qwen?.offValue, 'none')

const ifm = mod.parseEffortOffer(IFM_OFFER)
check('a "Supported values:" list is parsed', ifm === null ? null : [...ifm.levels].sort(), ['high', 'low', 'medium', 'none'])
check('a list without a default keeps provider default', ifm?.defaultLevel, null)

const tencent = mod.parseEffortOffer(TENCENT_OFFER)
check('a slash list behind "should be" is parsed', tencent === null ? null : [...tencent.levels].sort(), ['high', 'low', 'none'])
check('the Tencent off alias is kept for dispatch', tencent?.offValue, 'no_think')
check('the Tencent list has no declared default', tencent?.defaultLevel, null)

check('an unrelated "should be" error is not a vocabulary',
  mod.parseEffortOffer('Tool call IDs should be alphanumeric strings with length 9!'), null)
check('a message without a list is not a vocabulary', mod.parseEffortOffer('not a template error'), null)

const FALSE_ORIGIN = 'http://127.0.0.1:1'
const DYNAMIC_ORIGIN = 'http://127.0.0.1:3'
const STANDARD_ORIGIN = 'http://127.0.0.1:4'
const TENCENT_ORIGIN = 'http://127.0.0.1:5'
const THINKING_ORIGIN = 'http://127.0.0.1:6'
const NO_REASONING_ORIGIN = 'http://127.0.0.1:7'

mod.__setEffortCatalog(DYNAMIC_ORIGIN, {
  mode: 'server',
  levels: new Set(['none', 'low', 'medium', 'xhigh']),
  defaultLevel: 'xhigh',
  offValue: 'none',
})
const dynamic = mod.reasoningInfo(DYNAMIC_ORIGIN)
check('server levels replace the old ladder', dynamic?.efforts.map((effort) => effort.id), ['off', 'low', 'medium', 'xhigh'])
check('the server default is offered', dynamic?.defaultEffort, 'xhigh')
check('server levels keep their display names', dynamic?.efforts.map((effort) => effort.name), ['Off', 'Low', 'Medium', 'Extra high'])
check('a server level is sent verbatim', mod.resolveEffort(DYNAMIC_ORIGIN, 'xhigh'), { effort: 'xhigh' })
check('an unoffered level is not remapped', mod.resolveEffort(DYNAMIC_ORIGIN, 'high'), { omit: true })
check('off uses the server disable value', mod.resolveEffort(DYNAMIC_ORIGIN, 'off'), { effort: 'none' })
const dynamicBody = {}
mod.applyEffort(dynamicBody, mod.resolveEffort(DYNAMIC_ORIGIN, 'xhigh'))
check('the selected level reaches the request body', dynamicBody, { reasoning_effort: 'xhigh' })

mod.__setEffortCatalog(STANDARD_ORIGIN, {
  mode: 'standard',
  levels: new Set(['none', 'low', 'medium', 'high']),
  defaultLevel: 'medium',
  offValue: 'none',
})
const standard = mod.reasoningInfo(STANDARD_ORIGIN)
check('an unenumerated template gets the standard fallback', standard?.efforts.map((effort) => effort.id), ['off', 'low', 'medium', 'high'])
check('the standard fallback defaults to medium', standard?.defaultEffort, 'medium')
check('the standard fallback drops minimal', mod.resolveEffort(STANDARD_ORIGIN, 'minimal'), { omit: true })
check('a standard level is sent verbatim', mod.resolveEffort(STANDARD_ORIGIN, 'high'), { effort: 'high' })

mod.__setEffortCatalog(TENCENT_ORIGIN, {
  mode: 'server',
  levels: new Set(['none', 'low', 'high']),
  defaultLevel: null,
  offValue: 'no_think',
})
const tencentInfo = mod.reasoningInfo(TENCENT_ORIGIN)
check('Tencent offers its own levels', tencentInfo?.efforts.map((effort) => effort.id), ['off', 'low', 'high'])
check('Tencent has no invented default', tencentInfo?.defaultEffort, undefined)
check('Tencent off sends no_think', mod.resolveEffort(TENCENT_ORIGIN, 'off'), { effort: 'no_think' })

mod.__setEffortCatalog(THINKING_ORIGIN, {
  mode: 'thinking',
  levels: new Set(),
  defaultLevel: null,
  offValue: 'none',
})
const thinking = mod.reasoningInfo(THINKING_ORIGIN)
check('enable_thinking offers a binary control', thinking?.efforts.map((effort) => effort.id), ['off', 'on'])
check('the binary control has no invented default', thinking?.defaultEffort, undefined)
check('on uses the thinking switch', mod.resolveEffort(THINKING_ORIGIN, 'on'), { thinking: true })
const thinkingBody = {}
mod.applyEffort(thinkingBody, mod.resolveEffort(THINKING_ORIGIN, 'on'))
check('the on switch reaches the request body', thinkingBody, { chat_template_kwargs: { enable_thinking: true } })

mod.__setEffortCatalog(NO_REASONING_ORIGIN, {
  mode: 'none',
  levels: new Set(),
  defaultLevel: null,
  offValue: 'none',
})
check('a non-reasoning template offers no control', mod.reasoningInfo(NO_REASONING_ORIGIN), undefined)
check('a non-reasoning template sends no effort', mod.resolveEffort(NO_REASONING_ORIGIN, 'medium'), { omit: true })

mod.__setEffortCatalog(FALSE_ORIGIN, undefined)
check('an unprobed endpoint sends no effort', mod.resolveEffort(FALSE_ORIGIN, 'high'), { omit: true })
check('off never needs the template', mod.resolveEffort(FALSE_ORIGIN, 'off'), { effort: 'none' })
const noEffortBody = {}
mod.applyEffort(noEffortBody, mod.resolveEffort(FALSE_ORIGIN, 'high'))
check('omitted effort leaves the request body alone', noEffortBody, {})

// The catalog refresh probes the live template and replaces a stale vocabulary.
if (serverUp) {
  mod.__setEffortCatalog(origin, {
    mode: 'server',
    levels: new Set(['none', 'stale-level']),
    defaultLevel: null,
    offValue: 'none',
  })
  mod.__forgetCatalog(origin)
  await mod.catalogFor(origin)
  const refreshed = mod.__effortCatalog(origin)
  check('catalog refresh replaces a stale vocabulary', refreshed?.mode, 'server')
  check('the stale level is gone', refreshed?.levels.has('stale-level'), false)
  check('the catalog learns the server default', refreshed?.defaultLevel, 'xhigh')

  const offered = mod.reasoningInfo(origin)
  check('the live descriptor is the server set', offered?.efforts.map((effort) => effort.id), ['off', 'low', 'medium', 'xhigh'])
  check('the live descriptor uses the server default', offered?.defaultEffort, 'xhigh')
  for (const effort of offered?.efforts ?? []) {
    const resolved = mod.resolveEffort(origin, effort.id)
    check(`"${effort.id}" resolves to a server value`, resolved.omit !== true, true)
    if (resolved.effort === undefined) continue
    const res = await fetch(origin + '/apply-template', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], add_generation_prompt: true, reasoning_effort: resolved.effort }),
    })
    await res.text()
    check(`"${effort.id}" -> ${resolved.effort} renders`, res.ok, true)
  }
} else {
  skip('catalog refresh and live effort rendering')
}

// --- 3. route profiles, aliases, and directory rows ----------------------
console.log('\n-- route config --')
{
  const one = mod.resolveServerProfiles({
    servers: {
      devbox: { alias: 'devbox', baseURL: 'http://devbox.local:9931/v1', apiKeyEnv: 'DEVBOX_API_KEY' },
      office: { baseURL: 'http://office.local:8080/v1/' },
    },
  })
  check('every declared server becomes a route', [...one.routes.keys()], ['devbox', 'office'])
  check('an explicit alias is kept', one.routes.get('devbox').alias, 'devbox')
  check('an endpoint without an API path is rejected',
    (() => {
      const result = mod.resolveServerProfiles({ servers: { bare: { baseURL: 'http://bare.local:9931' } } })
      return [result.routes.size, result.errors.get('bare').includes('full http(s) API URL')]
    })(), [0, true])
  check('no alias falls back to the bare endpoint host and port', one.routes.get('office').alias, 'office.local:8080')
  check('a stored alias loses the display wrapper',
    mod.resolveServerProfiles({ servers: { lab: { alias: 'llama.cpp (lab)', baseURL: 'http://lab:9931/v1' } } }).routes.get('lab').alias, 'lab')
  check('a trailing slash is trimmed', one.routes.get('office').baseURL, 'http://office.local:8080/v1')
  check('each keeps its own origin', [one.routes.get('devbox').origin, one.routes.get('office').origin],
    ['http://devbox.local:9931', 'http://office.local:8080'])
  check('the credential reference is kept, not resolved', one.routes.get('devbox').apiKeyEnv, 'DEVBOX_API_KEY')

  const bad = mod.resolveServerProfiles({
    servers: {
      broken: { baseURL: 'ftp://x' },
      '1bad': { baseURL: 'http://x:1/v1' },
      badcred: { baseURL: 'http://x:2/v1', apiKeyEnv: 'not a ref' },
      good: { baseURL: 'http://good:9931/v1' },
    },
  })
  check('one bad route does not hide the good one', [...bad.routes.keys()], ['good'])
  check('the bad routes are declared with errors', bad.declared.map((entry) => entry.provider), ['broken', '1bad', 'badcred', 'good'])
  check('the errors name the route and field', [
    bad.errors.get('broken').includes('baseURL'),
    bad.errors.get('1bad').includes('route id'),
    bad.errors.get('badcred').includes('apiKeyEnv'),
  ], [true, true, true])
  check('an empty map declares no routes', [...mod.resolveServerProfiles({ servers: {} }).routes.keys()], [])

  // The picker's label comes from the adapter, not from the route string.
  installLive({ alias: 'devbox' })
  check('the adapter prefixes the bare alias for display',
    mod.createLlamaAdapter({}).providerInfo(route).name, 'llama.cpp (devbox)')
  installLive()
}

// --- 3a. the config schema and the directory the Models page reads -------
console.log('\n-- config schema and provider directory --')
{
  check('the row declares a config schema', typeof mod.Config, 'function')
  check('servers is a volatile dict, which is what publishes the namespace',
    [mod.Config.dict.servers.type, mod.Config.dict.servers.meta.volatile], ['dict', true])
  const inner = mod.Config.dict.servers.inner.dict
  check('a server profile has only alias, baseURL, and apiKeyEnv',
    Object.keys(inner).sort(), ['alias', 'apiKeyEnv', 'baseURL'])
  const resolved = mod.Config({ servers: { office: { alias: 'office', baseURL: 'http://office.local:8080/v1', apiKeyEnv: 'OFFICE_KEY' } } })
  check('a declared profile survives validation', Object.keys(resolved.servers.get()), ['office'])
  check('an omitted map validates to an empty one', Object.keys(mod.Config({}).servers.get()), [])

  const profiles = mod.resolveServerProfiles({
    servers: {
      devbox: { alias: 'devbox', baseURL: 'http://devbox.local:9931/v1' },
      office: { baseURL: 'http://office.local:8080/v1' },
      broken: { baseURL: 'ftp://x' },
    },
  })
  const entries = mod.directoryEntriesFor(profiles.routes, 'dsh-llm-llamacpp', profiles)
  check('every declared route gets one row, then one add row',
    entries.map((entry) => [entry.provider, entry.settingsPath.join('.'), entry.declared]),
    [
      ['devbox', 'servers.devbox', true],
      ['office', 'servers.office', true],
      ['broken', 'servers.broken', true],
      ['llamacpp', 'servers.llamacpp', true],
    ])
  check('a row names the namespace and endpoint it belongs to',
    [entries[0].settingsNs, entries[0].displayName, entries[0].defaultBaseURL],
    ['dsh-llm-llamacpp', 'llama.cpp (devbox)', 'http://devbox.local:9931/v1'])
  check('a derived alias is prefixed only in the row label',
    [profiles.routes.get('office').alias, entries[1].displayName],
    ['office.local:8080', 'llama.cpp (office.local:8080)'])
  check('a broken row carries its error', typeof entries[2].error, 'string')
  check('the add row invites the first free server', entries.at(-1).provider, 'llamacpp')
  check('the add row starts at the local server', entries.at(-1).defaultBaseURL, 'http://127.0.0.1:9931/v1')
  check('the add row moves past every declared id',
    mod.directoryEntriesFor(profiles.routes, 'ns', { ...profiles, declared: [...profiles.declared, { provider: 'llamacpp' }] })
      .map((entry) => entry.provider).at(-1), 'llamacpp-2')
}

// --- 3a'. credentials are resolved per operation and sent upstream -------
console.log('\n-- credentials and upstream auth --')
{
  const http = await import('node:http')
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push([req.url, req.headers.authorization ?? null])
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'm', name: 'm' }] }))
      return
    }
    if (req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model_alias: 'm', total_slots: 1, default_generation_settings: { n_ctx: 4096, params: { n_predict: -1 } } }))
      return
    }
    if (req.url === '/slots') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('[]')
      return
    }
    if (req.url === '/metrics') {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.url === '/v1/chat/completions' || req.url === '/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\n',
        'data: [DONE]\n\n',
      ].join(''))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const localOrigin3 = `http://127.0.0.1:${server.address().port}`
  const credentials = {
    resolve: async (ref) => (ref === 'TEST_KEY' ? { value: 'secret', source: 'file' } : undefined),
  }
  const authCtx = { get: (name) => (name === 'credentials' ? credentials : undefined), attachments: {} }
  const missingCtx = { get: () => undefined, attachments: {} }
  delete process.env.MISSING_KEY
  try {
    mod.__setLlama({ provider: route, baseURL: localOrigin3 + '/v1', origin: localOrigin3, apiKeyEnv: 'TEST_KEY' })
    mod.__clearCatalogs()
    const adapter = mod.createLlamaAdapter(authCtx)
    const resolved = await adapter.resolveModel(route, 'm')
    check('adapter catalog reads carry the credential',
      seen.filter(([path]) => path === '/v1/models' || path === '/props').every(([, auth]) => auth === 'Bearer secret'),
      true)
    check('the automatic context survives the credential path', resolved.context?.contextWindow, 4096)
    const probed = await mod.probeOrigin(localOrigin3, { authorization: 'Bearer secret' })
    check('the live probe reads an authenticated server', probed.state, 'llama')
    check('the metrics probe carries the credential',
      seen.filter(([path]) => path === '/metrics').every(([, auth]) => auth === 'Bearer secret'), true)
    const chunks = []
    for await (const chunk of mod.llamaStream(authCtx, {
      provider: route, model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(chunk)
    check('chat sends the credential', seen.find(([path]) => path === '/v1/chat/completions' || path === '/chat/completions')?.[1], 'Bearer secret')
    check('the authenticated call still finishes', chunks.at(-1)?.type, 'finish')

    mod.__setLlama({ provider: route, apiKeyEnv: 'MISSING_KEY' })
    mod.__clearCatalogs()
    const missing = await mod.createLlamaAdapter(missingCtx).resolveModel(route, 'm').then(() => null, (error) => error.code)
    check('a set-but-missing reference fails loudly', missing, 'MISSING_CREDENTIAL')
    const missingStream = await mod.llamaStream(missingCtx, {
      provider: route, model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }).next().then(() => null, (error) => error.code)
    check('chat refuses a set-but-missing reference', missingStream, 'MISSING_CREDENTIAL')
    const live = mod.createLiveHandler(missingCtx, { pollMs: 500 })
    const answer = await new Promise((resolve) => {
      live(
        { method: 'GET', url: '/llamacpp-metrics/live?provider=' + encodeURIComponent(route) + '&retry=1' },
        { writeHead(_status, _headers) {}, end(text) { resolve(JSON.parse(text)) } },
      )
    })
    check('the live endpoint reports a missing credential', [answer.state, answer.credential, answer.credentialRef], ['unauthorized', 'missing', 'MISSING_KEY'])

    const launchCtx = { launchEnvironment: { get: (ref) => (ref === 'LAUNCH_KEY' ? { value: 'launch-secret' } : undefined) }, attachments: {} }
    mod.__setLlama({ provider: route, apiKeyEnv: 'LAUNCH_KEY' })
    mod.__clearCatalogs()
    await mod.createLlamaAdapter(launchCtx).resolveModel(route, 'm')
    check('the launch environment is the ambient fallback',
      seen.at(-1)?.[1] === 'Bearer launch-secret' || seen.some(([, auth]) => auth === 'Bearer launch-secret'), true)

    // Discovery reuses the stored route's reference when the draft supplies none.
    mod.__setLlama({ provider: route, apiKeyEnv: 'TEST_KEY' })
    const discovered = await mod.discoverLlamaModels(authCtx, { provider: route })
    check('discovery lists the server models', discovered.map((entry) => entry.id), ['m'])
    check('discovery uses the stored credential', seen.filter(([path]) => path === '/v1/models').at(-1)?.[1], 'Bearer secret')
  } finally {
    server.close()
  }
}

// --- 3a''. draft interrogation runs against the endpoint the draft names ---
console.log('\n-- model discovery for a draft --')
{
  const http = await import('node:http')
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push([req.url, req.headers.authorization ?? null])
    if (req.url === '/props') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'qwen' }, { id: 'qwen' }, { id: 'llama-3', name: 'Llama 3' }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const localOrigin4 = `http://127.0.0.1:${server.address().port}`
    const ctx = { get: () => undefined }
    const models = await mod.discoverLlamaModels(ctx, { baseURL: localOrigin4 + '/v1', apiKey: 'draft-key' })
    check('discovery lists each advertised model once',
      models.map(({ id, name }) => ({ id, ...(name === undefined ? {} : { name }) })),
      [{ id: 'qwen' }, { id: 'llama-3', name: 'Llama 3' }])
    check('discovery asks the models endpoint with the draft key',
      seen.filter(([path]) => path === '/v1/models'), [['/v1/models', 'Bearer draft-key']])
  } finally {
    server.close()
  }
  check('discovery refuses a non-http endpoint',
    await mod.discoverLlamaModels({ get: () => undefined }, { baseURL: 'ftp://x/v1' }).then(() => 'resolved', (error) => error.message),
    'dsh-llm-llamacpp: model discovery needs a full http(s) baseURL including its path (got "ftp://x/v1")')
}

// --- 3b. the adapter serves exactly one route ----------------------------
// Anything else must fail loudly instead of quietly posting to this server.
{
  let refusal = null
  try {
    for await (const chunk of mod.llamaStream({ attachments: {} }, {
      provider: 'deepseek-official', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) void chunk
  } catch (error) {
    refusal = [error.code, error.message]
  }
  // The message names the route that was asked for and the ones that do exist, so a
  // typo in a session's provider is answerable; the exact list is not asserted
  // because other sections install their own routes.
  check('a request for another provider is refused',
    [refusal?.[0], refusal?.[1]?.includes('deepseek-official'), refusal?.[1]?.includes(route)],
    ['INVALID_REQUEST', true, true])
}

// The descriptor path enforces the same rule, so the picker cannot advertise a
// route this plugin does not serve.
{
  let rejected = null
  try { await mod.createLlamaAdapter({}).resolveModel('deepseek-official', model) } catch (error) { rejected = error.message }
  check('resolving another provider is rejected',
    typeof rejected === 'string' && rejected.includes('deepseek-official') && rejected.includes(route), true)
}

// --- 4. live call through the plugin's own adapter path ------------------
installLive()
mod.__clearCatalogs()
clearProgress()
const liveCtx = { attachments: { readImage: async () => { throw new Error('no images in this test') } } }
const filler = Array.from({ length: 900 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog number ${i}.`).join('\n')
const t0 = Date.now()
const chunks = []
const seenPrompt = new Set()
let lastNewTokensAt = 0
let maxGap = 0
let maxDecoded = 0
for await (const chunk of mod.llamaStream(liveCtx, {
  provider: route,
  model,
  sessionId: 'test-session',
  reasoningEffort: 'high',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: ok\n\n' + filler }] }],
  maxTokens: 1,
})) {
  const now = Date.now()
  chunks.push(chunk)
  if (chunk.type === 'usage') console.log(`usage @${((now - t0) / 1000).toFixed(2)}s`, JSON.stringify(chunk.usage))
  if (chunk.type === 'finish') console.log(`finish @${((now - t0) / 1000).toFixed(2)}s`, JSON.stringify(chunk.reason))
  if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') {
    const gap = now - (lastNewTokensAt || t0)
    if (lastNewTokensAt !== 0 && gap > maxGap) maxGap = gap
    lastNewTokensAt = now
  }
  for (const entry of mod.__progress().values()) {
    if (entry.phase === 'prompt' && typeof entry.processed === 'number') seenPrompt.add(entry.processed)
    if (typeof entry.decoded === 'number') maxDecoded = Math.max(maxDecoded, entry.decoded)
  }
}
console.log(`\nelapsed=${((Date.now() - t0) / 1000).toFixed(2)}s chunks=${chunks.length}`)
console.log('chunk types:', JSON.stringify(chunks.map(c => c.type)))
// What the loop actually hands the adapter, readable from the payload: the type
// declarations cannot answer this (an adapter may read an undeclared field).
const traced = mod.__requestTrace()
check('the request key set is traced for the payload',
  [traced.keys.includes('provider'), traced.keys.includes('model'), traced.keys.includes('messages')], [true, true, true])
check('nothing tool-choice shaped reaches the adapter', traced.keys.some((key) => /tool_choice|toolChoice/i.test(key)), false)
const liveLeft = [...mod.__progress().values()]
check('the finished request is held, not deleted', liveLeft.length > 0 && liveLeft.every((entry) => typeof entry.endedAt === 'number'), true)
for (const entry of mod.__progress().values()) entry.endedAt = Date.now() - 5001
check('and it drains once the hold passes', mod.__liveProgress().length, 0)
check('a finish chunk was emitted', chunks.some(c => c.type === 'finish'), true)
check('distinct prompt readings observed', seenPrompt.size > 0, true)
check('the live request counts its own generated tokens', maxDecoded >= 1, true)

// The live usage must keep the disjoint invariant: the uncached input plus the
// cache read never exceeds the reported total, and the total is the disjoint
// sum (input + cache + output) rather than the provider's cache-inclusive one.
const liveUsage = chunks.find(c => c.type === 'usage')?.usage
if (liveUsage === undefined) {
  console.log('skip live usage check: no usage chunk observed')
} else {
  check('live usage is disjoint', liveUsage.inputTokens + (liveUsage.cacheReadTokens ?? 0) <= liveUsage.totalTokens, true)
  check('live total is the disjoint sum',
    liveUsage.inputTokens + (liveUsage.cacheReadTokens ?? 0) + liveUsage.outputTokens,
    liveUsage.totalTokens)
}

// --- 4f. apply works without the web server (headless) ---------------------
// The headless bundle mounts no HTTP server. The routes, directory, and model
// discovery must still register; the metrics endpoints attach only when
// `webServer` is available, through the nested optional injection.
console.log('\n-- headless apply --')
{
  const config = mod.Config({ servers: { llamacpp: { baseURL: 'http://127.0.0.1:9931/v1' } } })
  const makeCtx = (over = {}) => {
    const log = []
    const ctx = {
      fiber: { entry: { options: { id: 'dsh-llm-llamacpp', config } } },
      llm: {
        registerAdapter: (routes) => {
          log.push(['registered', routes])
          return Object.assign(() => log.push(['adapter-disposed']), { replace: () => {} })
        },
        registerConfigurableProviders: (entries) => {
          log.push(['published', entries.map((entry) => entry.provider)])
          return Object.assign(() => log.push(['directory-disposed']), { replace: () => {} })
        },
        registerModelDiscovery: (ns) => { log.push(['discovery', ns]); return () => {} },
      },
      effect: (fn) => fn(),
      on: () => () => {},
      logger: { warn: () => {} },
      ...over,
    }
    return { ctx, log }
  }

  const headless = makeCtx()
  let applyError = null
  let dispose = null
  try {
    dispose = mod.apply(headless.ctx, config)
  } catch (error) {
    applyError = error
  }
  check('the plugin does not require a web server', mod.inject, ['llm', 'attachments'])
  check('apply mounts without a web server', applyError?.message ?? null, null)
  check('the routes still register in headless', headless.log,
    [['registered', ['llamacpp']], ['published', ['llamacpp', 'llamacpp-2']], ['discovery', 'dsh-llm-llamacpp']])
  dispose?.()

  const paths = []
  const web = makeCtx({
    inject: (deps, callback) => {
      if (deps.includes('webServer')) {
        callback({
          webServer: { register: (route) => { paths.push(route.path); return () => {} } },
          effect: (fn) => fn(),
        })
      }
      return { dispose: () => {} }
    },
  })
  const disposeWeb = mod.apply(web.ctx, config)
  check('web endpoints register through the optional injection', paths,
    ['/llamacpp-metrics/live', '/llamacpp-metrics/config'])
  disposeWeb()
}

// --- 5. the Models page's write path (a volatile commit, no re-apply) ------
// The page's card writes `servers.<route>` through `settings.mutate`; the loader
// commits the volatile reference IN PLACE and announces `loader/volatile-update`.
// This drives exactly that: the reference is written and the announcement fired, so
// what is asserted here is what happens in the running host.
console.log('\n-- a settings write re-points the routes --')
{
  const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
  const raw = { servers: { llamacpp: { alias: 'one', baseURL: 'http://one.local:8080/v1' } } }
  const config = mod.Config({ servers: { llamacpp: { alias: 'one', baseURL: 'http://one.local:8080/v1' } } })
  const log = []
  const handlers = {}
  const adapterHandle = Object.assign(() => log.push(['adapter-disposed']), { replace: (routes) => log.push(['routes', routes]) })
  const directoryHandle = Object.assign(() => log.push(['directory-disposed']), { replace: (entries) => log.push(['entries', entries.map((entry) => entry.provider)]) })
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-llm-llamacpp', config: raw } } },
    llm: {
      registerAdapter: (routes) => { log.push(['registered', routes]); return adapterHandle },
      registerConfigurableProviders: (entries) => { log.push(['published', entries.map((entry) => entry.provider)]); return directoryHandle },
      registerModelDiscovery: (ns) => { log.push(['discovery', ns]); return () => {} },
    },
    webServer: { register: () => () => {} },
    effect: (fn) => fn(),
    on: (name, handler) => { handlers[name] = handler; return () => {} },
    logger: { warn: (message) => log.push(['warn', String(message)]) },
  }
  const dispose = mod.apply(ctx, config)
  check('apply registers the routes, publishes their rows plus the add row, and the discovery probe',
    log, [['registered', ['llamacpp']], ['published', ['llamacpp', 'llamacpp-2']], ['discovery', 'dsh-llm-llamacpp']])

  const commit = (next) => {
    log.length = 0
    config.servers[VOLATILE_WRITE](next)
    raw.servers = next
    handlers['loader/volatile-update']()
  }
  commit({ office: { alias: 'office', baseURL: 'http://two.local:8080/v1' } })
  check('a committed map swaps the routes in place', log,
    [['routes', ['office']], ['entries', ['office', 'llamacpp']]])
  commit({})
  check('emptying the map holds zero routes and keeps the add row', log,
    [['routes', []], ['entries', ['llamacpp']]])
  commit({ broken: { baseURL: 'ftp://x' } })
  check('a broken declaration becomes a row error without taking the route set down',
    [log.find(([kind]) => kind === 'routes')?.[1], log.some(([kind]) => kind === 'warn'), log.find(([kind]) => kind === 'entries')?.[1]],
    [undefined, true, ['broken', 'llamacpp']])

  // The host refuses a settings write it could not serve before committing it.
  let refused = null
  try {
    handlers['internal/config'].call(ctx.fiber, raw, () => ({ servers: { bad: { baseURL: 'ftp://x' } } }))
  } catch (error) {
    refused = error.message
  }
  check('a settings write with a bad endpoint is refused', typeof refused === 'string' && refused.includes('bad') && refused.includes('baseURL'), true)
  check('a valid settings write is accepted',
    handlers['internal/config'].call(ctx.fiber, raw, () => ({ servers: { good: { baseURL: 'http://good:9931/v1' } } })) !== undefined, true)
  check('the credential-rotation listener is registered', typeof handlers['credentials/reference-updated'], 'function')

  log.length = 0
  dispose()
  check('teardown releases both registrations', log,
    [['adapter-disposed'], ['directory-disposed']])
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
