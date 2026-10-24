# dsh-llm-llamacpp — agent handoff

A Cordis plugin for the DeepSeek Harness. When a Session's model is served by a
**llama.cpp** server, a pill in the composer dock shows *this session's* live
progress (`prompt 250/1K (25%) · ETA 5s · 100 tok/s`, then
`decode · 226 tok · 44 tok/s`); clicking it opens the raw server readings.
Per-request progress exists only in the SSE stream of a request this process
dispatched, which is why the plugin owns the stream.

## Files

| File | Role |
|---|---|
| `index.js` | Host: minimal server profile (`alias`, `baseURL`, `apiKeyEnv`), one `llm` route per declared server, one Settings → Models directory row per route plus an add row, `/llamacpp-metrics/live` and `/config`, authenticated model discovery and server facts (models, context, output cap). |
| `client.js` | Client: dock pill + dialog, and the Settings → Models provider card. Pure helpers first (the suite renders them), then `useLiveSnapshot`, then the components. |
| `cordis.patch.yml` | The plugin row: an **empty** `servers` map (each key becomes a route) plus `clientPollMs` and `streamIdleTimeoutMs`. A route profile is only `alias`, `baseURL`, and `apiKeyEnv`; servers are added from Settings → Models. |
| `package.json` | `dsh.bundle.patch` + `dsh.client` (injects `dsh-client-ui-conversation` for the dock, `dsh-api-remotes` for the card's writes). Runtime dependency `@deepseek-ai/schemastery` provides the config schema. |
| `locale/en.json` | Plugin `meta` only; UI strings live in `client.js` (`dict`). |
| `icon.svg` | Official llama.brand mark (see `CREDITS.md`). |
| `TODO.md` | Durable backlog and the motivation for each remaining item. The Harness `todo_write` projection is turn-scoped and resets at every `turn/start`, so this file is the canonical list across turns and sessions. |
| `LLAMA_CPP_INTEGRATION.md` | Upstream llama.cpp/OpenAI-server changes that would improve DSH integration: image token accounting, native tool updates, template capability flags, slot affinity, and usage metadata. |
| `test/host-test.mjs` | Host suite: real `LlmRuntime` routing, descriptors, automatic model/context/cap facts, credentials, usage, images, reasoning-level discovery/fallbacks, failure paths, live `llamaStream`, the settings-write path. |
| `test/client-test.mjs` | Client suite: label chain, notes, dialog payload, formatters, source invariants, and the card mounted through `card-runtime.mjs`. |
| `test/card-runtime.mjs` | Minimal hooks runtime over the real card: mount, click, type, blur, re-render. |
| `test/parity-test.mjs` | Parity suite: upstream faults through the real `LlmRuntime` against pi-ai's codes and retry policy, plus the request shape. |
| `test/template-test.mjs` | Optional live template matrix: starts `llama-server` with `--chat-template-file` for Gemma 2, Mistral Small/Nemo, Qwen 2.5, and Qwen 3.5 and checks leading/mid-history system behavior through `/apply-template`. |

## How it works

```
apply ─────────► resolveServerProfiles() → registerAdapter(serviceable routes)
               └► registerConfigurableProviders(declared rows + errors + one add row)
               └► registerModelDiscovery(ns)
stream ────────► POST ${baseURL}/chat/completions; SSE frames → StreamChunks,
                 teeing prompt_progress/timings into `progress`
client ────────► GET /llamacpp-metrics/live?provider&model[&retry=1][&live=1]
               └► GET /llamacpp-metrics/config (namespace + what the page sees)
page (card) ───► settings.mutate(ns, servers.<route> ops) → volatile commit →
                 `loader/volatile-update` → refresh() → replace(routes)
```

## Facts that are easy to get wrong

- **Declared routes, no interception.** Every key of `servers` is a provider
  route; `llamaStream` refuses an undeclared provider with `INVALID_REQUEST`
  naming the declared ones. Nothing is probed or rewritten.
- **Headless has no web server.** The plugin injects only `llm` and
  `attachments`; `/llamacpp-metrics/live` and `/config` are registered through a
  nested optional `webServer` injection. A headless profile therefore gets the
  routes, model discovery, and streaming, but not the dialog endpoints or the
  web client. `webServer` must never return to the top-level `inject` list: that
  silently stops the plugin from mounting at all in headless.
- **Settings → Models is the editor, and three things make it work.** `Config`
  marks `servers` **volatile**: that publishes the namespace (`describe()` drops
  entries without a volatile field) and lets a write land. The page gets one row
  per route plus **one add row** at the first free `llamacpp*` id, labelled
  "llama.cpp (new server)"; it moves as servers take ids, so "Add model provider"
  can always create one. A write is path-addressed and revision-fenced, and names
  only the fields the card owns (`alias`, `baseURL`, `apiKeyEnv`). The loader
  commits the map in place, `loader/volatile-update` fires, and `refresh()`
  replaces routes and rows — no reload, no re-apply.
- **An empty map means no routes.** There is no flat/env fallback; `servers` is
  the only profile form.
- **The card follows the row's own Edit.** The slot is dispatched on every row and
  gets no `open` prop, so the card looks for the page's editor element in the row
  (class ending `_editor`) with a `MutationObserver`, and renders nothing while
  closed. A slot occupant is not guaranteed to re-render with its parent, so a
  render-time check does not work.
- **The page's unknown-family editor is hidden, not replaced.** While our card is
  mounted it sets `data-llamacpp-hidden` on the page editor in its row (or the
  add panel) and removes it on unmount, so the page's cordis hint and disabled
  Apply/Cancel do not duplicate our form. The hidden page Cancel is still the
  button our Cancel and a successful save/add click to close.
- **The card is only URL + Customized settings + one footer.** Alias and API key
  live under Customized settings; there is no route-name field, Fetch button, or
  success status. An existing row probes once on open, and the URL/key fields
  probe on blur; a failure is a subtle hint under the URL, success renders
  nothing. The model list itself is fetched by the host when the picker resolves
  the route.
- **Each configured row paints its server status in the page header.** A
  low-frequency client poll (15 s, paused while the tab is hidden) asks
  `/llamacpp-metrics/live?provider=…&retry=1`; the card sets
  `data-llamacpp-status` on its row, and the stylesheet draws a green/red dot
  after the row identity (gray while checking). The dot is not shown for the
  dormant add draft, which has no server yet.
- **A server restart must invalidate the model picker catalog.** The browser
  caches the catalog until a forwarded event, and an outage leaves an empty
  provider group. `/live` compares the previous verdict with the retry probe;
  on an online/offline transition (or while online with an empty cached catalog)
  it deletes `catalogs[origin]` and calls `adapterHandle.replace(routes)`, which
  publishes `llm/adapters-updated`. A global client watcher polls `/config` and
  one `/live?retry=1` per route every 15 s from any page, so the transition is
  detected even when the Models cards are unmounted. The dialog's own poll also
  forces `retry=1` while its last answer is not a healthy `llama` verdict, so a
  server that was down when the dialog opened is noticed when it returns; a
  healthy dialog poll uses the cached verdict. No host timer is added.
- **The route id is the map key, and the GUI never asks for it.** The add row
  auto-assigns the first free `llamacpp*` id; changing it is a hand edit of the
  `servers` map key in the patch file (it would also move the settings subtree and
  invalidate persisted provider selections).
- **`alias` is bare; the UI adds the prefix.** A route with no alias uses its
  endpoint's `host:port` (or route id); the picker and Models row render
  `llama.cpp (<alias>)`. The alias is written as `alias`, not `displayName`; a
  value that still contains the `llama.cpp (...)` wrapper is stored without it.
- **`prepareCall` and `resolveModel` must return the same descriptor.** The picker
  stores `reasoning.defaultEffort` and the request path validates it against
  `prepareCall`'s answer.
- **The profile has no capability numbers.** `/v1/models` supplies ids and
  modalities; `/props` supplies the alias, `default_generation_settings.n_ctx`,
  and `params.n_predict`/`max_tokens` when positive. `/props` is fetched in
  parallel with the model list, so a server whose model list is missing still
  contributes its alias and context. The loaded `/props` context wins over
  `/v1/models` `meta.n_ctx`; both are loaded-context figures (`n_ctx_train` is the
  training context), and meta is the fallback when props omits it. A model row
  without an `architecture.input_modalities` or multimodal capability takes its
  input modalities from `/props` for the served model, so a vision-capable
  llama.cpp model is not advertised as text-only.
  `describe()` reports `context` and `defaultMaxTokens` from those live readings;
  no configured value can override them. If neither reports a window, omit
  `context` rather than guess. `params.n_predict` is a generation cap, not a
  reserved output budget: a server started with a large `-n` makes the harness
  reserve that much, so prefer `-n -1` or a small cap for small-context models.
- **Reasoning levels are discovered, not configured.** Every route probes
  `/apply-template` on each catalog refresh and parses the template's own list
  (`Supported types are …`, `Supported values: …`, or `should be …`), including
  its `(default)` and off alias (`none`/`no_think`). The offered levels are the
  server's, sorted least to greatest. A template that accepts effort but never
  enumerates it falls back to `off/low/medium/high`, default `medium`; an
  `enable_thinking`-only template offers `off/on`; no reasoning control omits
  the field. A stale persisted level that the server dropped is rejected with
  `UNSUPPORTED_REASONING_EFFORT`. Kimi's separate `thinking_effort` variable is
  not reachable through llama.cpp's `reasoning_effort` and is out of scope.
- **System prompt updates are in-history.** The descriptor advertises
  `systemPromptUpdate: 'in-history'`, matching pi-ai. Templates disagree about
  system roles: some reject any leading system role, some only reject it after the
  conversation starts, and several require strict user/assistant alternation. The
  catalog probes `/apply-template` for leading-system support. If accepted,
  leading system messages are merged into one; if rejected, all system content is
  folded into the first user turn. A later system update is always folded into
  the next user turn. An inconclusive probe keeps the last known answer rather
  than re-enabling a role the template rejected. `toolUpdate` remains
  unadvertised, but that does not prevent ordinary mid-session tool changes:
  absent `toolUpdate` means every request declares the complete current tool
  list, so adding or removing a tool between turns works (verified through the
  real runtime: `read` → `read+write` → `read`). The missing part is only the
  addition-only/deferred-loading optimization; a deferred tool is declared on
  the first request instead of being activated by a later developer message.
  `/apply-template` applies llama.cpp's own leading-system workaround, so an
  effective 200 does not prove the raw Jinja accepts a system role. The
  template suite encodes the observed server behavior: Gemma 2 accepts a
  leading system message but rejects a raw mid-history one, while Qwen 2.5
  accepts both.
- **Assistant reasoning is replayed as `reasoning_content`.** llama.cpp's chat
  template preserves it only when the field is present; `blocksText` alone is
  not enough. The field carries the durable reasoning blocks (joined by blank
  lines) on the assistant turn, including tool-call turns where `content` is
  null. Reasoning from another provider/model is dropped (same rule as pi-ai),
  and a reasoning-only turn with blank text is skipped. Replaying reasoning
  keeps the next prompt close to the previous generation and makes the harness
  token meter price what the model actually sees; omitting it caused compaction
  at roughly half the real window on a 262k model. After a model switch, the old
  model's reasoning stays in the durable surface but is deliberately not sent;
  the token meter can therefore overestimate pressure until a new usage anchor,
  and the adapter has no surface-pricing hook to correct that fold.
- **A defaulted effort inherits the session's routed effort.** This is the
  llama.cpp counterpart of pi-ai's `options.reasoningEffort ??
  profile.reasoning`: a caller that leaves effort at the model default gets the
  session's last routed effort instead of the template default (often `xhigh`).
  llama.cpp renders `reasoning_effort` into the chat template, so a compaction or
  title call that fell back to the template default had a different prompt prefix
  from the conversation it continued and invalidated its KV cache. An explicit
  non-default effort is preserved, a different provider/model keeps its own
  default, and a request without a session is unchanged. This is generic to
  auxiliary and one-shot calls, not compaction-specific.
- **`usage` must be disjoint.** llama.cpp's `prompt_tokens` includes the cached
  prefix; `mapUsage` subtracts it.
- **Credentials are resolved per operation.** `apiKeyEnv` names a DSH credential
  reference; `llamaStream`, discovery, model resolution, `/props`, `/metrics`,
  `/slots`, and `/apply-template` all send the resolved `Authorization` header.
  There is no raw `apiKey` and no implicit environment fallback: a profile with
  no `apiKeyEnv` sends no auth. A reference that resolves to nothing fails with
  `MISSING_CREDENTIAL`; probes report `unauthorized`.
- **The User-Agent carries the plugin version.** Every upstream request sends
  `dsh-llm-llamacpp <package version>` (for example
  `dsh-llm-llamacpp 1.0.0`). The version is read from `package.json`; the
  generated test copy falls back to the parent manifest. This replaced the old
  fixed Harness-attribution string.
- **`baseURL` is the full API URL.** The path is required (llama-server's
  OpenAI-compatible base is `http://host:9931/v1`); only trailing slashes are
  trimmed. A bare `host:port` is rejected rather than silently sent to
  `/chat/completions`. Route ids are lowercase dash-separated
  (`llamacpp-lab`), which is also what the credential-reference grammar expects.
- **One bad route does not hide the rest.** `resolveServerProfiles()` validates
  each entry; the directory gets a row with `error` for a bad one while the good
  routes stay registered. `internal/config` refuses a bad settings write before
  commit.
- **Images:** `readImageRequest(ref, ctx.llm.imageRequestTarget(...))`, media type
  from the ref's `mediaType`, `offloaded` blocks never re-sent. Every image also
  carries pi-ai's model-facing handle text (identity, request preview size, and
  the normalized path when the host maps one). An offloaded image becomes
  pi-ai's omission placeholder: identity plus the normalized path when available,
  otherwise a request to attach it again. A tool-result image cannot ride
  on an OpenAI `tool` message: its handle text joins the tool text, and the image
  moves to a following user message `Attached image(s) from tool result:`; a run
  of consecutive tool results shares one such message. Empty results become
  `(no tool output)`. Verified against real pi-ai with a `read_image` result:
  both sent the same 7 messages, tool text, user handle, and image bytes.
  llama.cpp reports only the total prompt token count, which includes image
  chunks; it exposes no per-image visual-token count. `imageRequestPricing`
  therefore stays undefined: the token meter uses its fixed image-reference
  heuristic before a request and provider usage (including image tokens) for a
  completed request.
- **llama.cpp's media marker is defused in outgoing text.** `/props` exposes a
  process-random `media_marker`; `mtmd_tokenize` treats every exact occurrence
  in the rendered prompt as an image slot, even when it came from a plain tool
  result that echoed `/props`. One marker with no image fails the request with
  HTTP 400 `Failed to tokenize prompt`; a retry that resends the same text
  fails again. The adapter prevents that path: the catalog records the marker,
  and `defuseMediaMarkers()` inserts a zero-width space after the first
  character of each occurrence in the request body's string values before
  serialization. Object keys are not rewritten.
  Messages, tool results, tool arguments, reasoning, and tool declarations are
  covered. This is a workaround, not a substitute for the upstream fix in
  `LLAMA_CPP_INTEGRATION.md` §10. It cannot defuse a marker the catalog has
  never read (for example before the first `/props` probe).
- **Concurrent sessions pin llama.cpp slots.** An unpinned request is assigned
  by prompt similarity (`--slot-prompt-similarity`, default 0.1), so sessions
  sharing a long system prompt and tools can take each other's slot and discard
  its KV cache. `/props.total_slots` gives the pool size; the adapter sends
  `id_slot` with a stable per-session assignment (provider + session id), reuses
  the least recently seen **idle** assignment when the pool is full, and lets
  session-title calls use a free unassigned slot without evicting a conversation.
  Compaction stays on the session's own slot because DSH replays the conversation
  prefix and appends the instruction; on a warm 835-token prefix, a free slot
  processed 855 tokens with zero cached, while the session slot processed 21 new
  tokens with 834 cached. A generating sub-agent keeps its slot; if every slot is
  active, a new session stays unpinned. Each sub-agent has its own session id, so
  it gets its own slot until `total_slots` concurrent tasks are reached; beyond
  that, peak concurrency needs a larger `-np`.
  A one-slot server, a missing session id, or missing `total_slots` is left
  unpinned. The OpenAI endpoint copies `id_slot` through to llama.cpp's task.
- **Context checkpoints are llama.cpp's in-memory rewind mechanism.** Each slot
  keeps up to `--ctx-checkpoints` states (default 32, minimum spacing 8192
  tokens), created at user-message starts and near prompt end, and restores one
  when SWA/hybrid/recurrent memory cannot rewind to the common prefix. They are
  in memory, not an HTTP resource; a slot save file includes them. On Qwen3.8 one
  checkpoint was 112.571 MiB, so the default 32 is ~3.6 GiB per slot; `-cram`
  limits the idle-slot prompt cache (whose stored states include checkpoints),
  not an active slot's checkpoint list. Use an explicit `--ctx-checkpoints` /
  `--checkpoint-min-step` budget on memory-limited servers. Qwen3.8 is a `qwen35`
  hybrid with SSM layers, so checkpoint reuse matters. Keep pruning and
  compaction on the session's own slot so its checkpoints survive; the plugin
  cannot create or query checkpoints, and tool-call boundaries are not
  checkpointed (only user starts and prompt end).
- **`/slots` is a server view, not this session's.** The pill's counts and rates
  come only from its own SSE stream. The slots table joins rows to entries on
  cached-prefix length + context growth (one batch apart), closest pair first.
  The dialog summary's `server KV` sums every slot; its `session context` line is
  the active slot matched to this session and includes generated tokens
  (`prompt + decoded`). If no active slot matches this session, omit the session
  line rather than borrowing another session's slot. The harness context pill is
  a next-prompt projection
  updated at request boundaries, so it excludes in-flight generation and can read
  lower than the slot's live KV; do not compare it with `server KV`.
- **Parallel tool calls are keyed by the provider's `index`.** Tool-call
  fragments for different calls interleave, so one open block per call is kept
  until the stream ends; closing on every switch turns two calls into several
  incomplete ones with mixed arguments. pi-ai uses the same index-keyed map
  (`toolCallBlocksByIndex`) and finalizes every block after the stream. Text and
  reasoning remain exclusive; tool blocks stay open across them and are closed
  in first-appearance order at the end (or on abort). Verified by feeding the
  same interleaved stream to a real pi-ai headless profile and to this adapter:
  both produced one complete `call_a` and `call_b` with their own arguments.
- **Read SSE by frame, not by line.** Frames end at a blank line; keep the tail for
  split frames; detect abort explicitly; always cancel the reader in `finally`.
- **A failure is never an empty success.** Throw on an error frame, a malformed
  SSE frame (`LLAMA_CPP_ERROR`), an unknown or provider-error finish reason such
  as `content_filter`/`network_error` (`LLAMA_CPP_ERROR`), a stream with no finish reason
  (`TRANSPORT`, even when `[DONE]` arrived; pi-ai requires the provider finish
  reason), a `stop` with no content (`EMPTY_RESPONSE`), or a clean end with no
  terminal event (`STREAM_CLOSED`).
- **Rates are current speed, not averages.** decode: `Δpredicted_n/Δpredicted_ms`
  over `RATE_WINDOW_MS`, cumulative until `RATE_MIN_SPAN_MS`; prompt:
  `Δ(processed - cache)/Δtime_ms` — never `processed` alone (the cached prefix
  makes it read millions of tok/s), and keep the span floor (batch frames land
  1 ms apart).
- **A slot's context length is not a prompt rate.** `rateSlots` derives decode from
  `decoded` growth; a prompting slot outside the stream shows counts and no rate.
  A sample older than `RATE_TTL_MS` never produces a rate, even when `decoded`
  grew across the gap; the pair is stale, not current speed.
- **llama.cpp's metric names lie.** `predicted_tokens_seconds` divides decode
  *steps*, so `deriveMetrics` answers `decodeTps` from counters and leaves the
  gauge in `raw[]`. `prompt_tokens_seconds` is tokens/s. `n_tokens_max` is the
  largest sequence seen, not a batch size.
- **The dialog collapses sections; the preference persists** in `localStorage`
  (`dsh-llm-llamacpp:collapsed`). A collapsed heading carries its own headline.
- **The Live table is in launch order, not freshness** (`updatedAt` changes on
  every token).
- **Requests are named opportunistically** from `sessionProjections.cachedSnapshot`
  (`subagent`, `title`), through non-strict `ctx.get`.
- **No timers in the host.** Every upstream request follows a client poll or a
  config/adapter invalidation; `/metrics` and `/slots` are read only while the
  dialog is open (`live=1`).
- **Teardown clears module caches** (`resetState`).

## Parity with the stock pi-ai route

- **Retries follow `failure.code`.** `dsh-llm-retry` retries `EMPTY_RESPONSE,
  RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT`; `normalizeLlmFailure` keeps a code only
  for a `HarnessError` or a foreign error whose `failure` snapshot matches its own
  code. Failures therefore throw `adapterFailure(message, code)`: 429 →
  RATE_LIMIT, 5xx → SERVER, 401/403 → AUTH, 400/413/422 → INVALID_REQUEST, a
  408 → TIMEOUT, an unclassified status → LLAMA_CPP_ERROR, context overflow → CONTEXT_WINDOW_EXCEEDED, empty `stop` → EMPTY_RESPONSE, torn
  socket → TRANSPORT, clean end with no terminal event → STREAM_CLOSED, abort →
  `{kind:'aborted'}`.
- **A stalled stream fails, not hangs:** the same 300 s idle ceiling
  (`streamIdleTimeoutMs`, 0 disables) covers the wait for response headers, the
  non-200 error body, and stream body reads → TIMEOUT. pi-ai's idle watchdog
  spans the whole request.
- **Deliberate differences:** `stop` is honoured; `tool_choice` is never sent;
  a defaulted effort inherits the session's routed effort so auxiliary prompts
  stay cacheable (pi-ai falls back to its route-level `profile.reasoning`, and the
  stock compaction request leaves the effort at that route default); unclassified
  terminal failures use `LLAMA_CPP_ERROR` instead of pi-ai's `PI_AI_ERROR`.
- **Retry policy is the Harness default.** `providerRetryPolicy` returns
  `undefined`, so the runtime uses normal mode: 5 retries over `EMPTY_RESPONSE`,
  `RATE_LIMIT`, `SERVER`, `TIMEOUT`, and `TRANSPORT`, with 500 ms initial
  backoff, 10 s maximum, and 0.1 jitter. That is the same policy pi-ai resolves
  for a llama.cpp profile with no `retryPolicy`. `AUTH`, `INVALID_REQUEST`,
  `CONTEXT_WINDOW_EXCEEDED`, `STREAM_CLOSED`, and `LLAMA_CPP_ERROR` stay
  terminal. The plugin does not expose per-route retry configuration; a custom
  pi-ai `retryPolicy` is not carried over.
- **`replayState` is intentionally absent.** llama.cpp's OpenAI-compatible
  response is fully represented by the durable text, reasoning, and tool-call
  blocks; there are no provider-private signatures needed to reconstruct it.
  pi-ai still stores a replay envelope for OpenAI-compatible responses,
  including a response id when the provider supplies one, but that metadata is
  not needed for llama.cpp's durable content and this adapter would never read
  it. Emitting a state this adapter would never read would add dead metadata.
- **Known gaps:** no `toolUpdate` optimization (complete tool lists are sent
  every turn; mid-session additions/removals work, but deferred loading is not
  preserved).

## Traps

- **All plugin changes go through the fs tools.** Use `read`/`edit`/`write` for
  every source, test, doc, config, or locale change. Never use `sed`, `python`,
  heredocs, shell redirection, or any other bash write against the repo. This
  preserves the native changed-file card for review; bash is for inspection,
  builds, and tests only.
- **Brand assets, not drawings.** Copy the llama.brand paths verbatim; scale and
  single-colour only. Attribution lives in `CREDITS.md`.
- **Never mutate a React element's children** (they live in `props.children`); the
  suite's `h` stub freezes them.
- **Every hook runs before the pill's `snap` guard** — a throw is silent in the
  dock.
- **Bare imports resolve against the plugin's realpath.** Never import a harness
  package; a declared dependency (`@deepseek-ai/schemastery`) must be installed in
  this repo (`npm install`), since the profile link does not install it. The suites
  write their patched module inside the package for the same reason.
- **Host JS does not hot-reload:** toggle `include:dsh-llm-llamacpp`. Client JS
  loads on a page refresh. Neither implies the other.
- **The Models add list is not sorted** (directory declaration order; this family
  is last). The row label says what it is; typing `ll` jumps to it.
- **The provider-card slot has no `open` prop**; a card that renders unconditionally
  leaves every row expanded. The card follows and hides the page's own editor,
  probes once on open, and uses the hidden page Cancel for close.
- **No host console from here:** use `plugin_manager` and the payloads.
- **Look at visual changes:** `../.mockups/render.mjs` (dialog) and
  `../.mockups/card-render.mjs` (card) render the real components with shipped
  tokens; headless chromium screenshots them.

## Verify

1. `node --check index.js client.js`.
2. `node test/client-test.mjs`, `node test/parity-test.mjs` and
   `LLAMA_CPP_BASE=… LLAMA_CPP_MODEL=… node test/host-test.mjs` → all
   `ALL CHECKS PASSED`.
3. `LLAMA_CPP_TEMPLATE_MODEL=… node test/template-test.mjs` → all template
   checks pass (the suite starts a short-lived server per Gemma 2, Mistral
   Small/Nemo, Qwen 2.5, and Qwen 3.5 template).
4. Live: toggle the plugin after a host change, then
   `curl '…/llamacpp-metrics/live?provider=llamacpp&model=…&retry=1'` →
   `state:"llama"`, `online:true`, non-empty `progressLive` during a turn on that
   provider. `…/llamacpp-metrics/config` reports `settingsNs`, `routes`, `names`,
   `errors`, `declared`, `visible`, `servers`, `directory` — it is the page-facing
   health line.
5. Models → Add provider → llama.cpp: the only visible fields are Server URL and
   Customized settings; the page's unknown-family hint/footer are hidden; Cancel,
   Add, and Save all collapse the editor (Save after the write commits). Each
   configured row shows a green/red status dot beside its name. Stop and restart
   a local server: the composer model picker drops and restores its group within
   one 15 s watcher cycle, without a page reload. Refresh the page for client
   changes.
6. Commit every change.

## Environment

- Server: `http://devbox.local:9931/v1`, llama-server build `b11715-9d1878a43`
  (= `~/code/llama.cpp`), model `ggml-org/Qwen3.8-Flash-NEXT-GGUF:IQ4_NL`,
  5 slots × 262144 ctx.
- The card/add-row default endpoint (`DEFAULT_BASE_URL`, `SERVER_DEFAULT_URL`) is
  `http://127.0.0.1:9931/v1`, llama-server's own default since `b42b7e6d3`
  (PR #30159; older builds used 8080). A declared route must supply `baseURL`.
- Profile `web` (`~/.dsh/profiles/web/`); the plugin is installed from this repo's
  path (`link:/home/user/code/dsh-plugins/dsh-llm-llamacpp`) via Settings →
  Plugins or `plugin_manager install_bundle`. `remove_bundle` leaves the profile
  patch row and the `node_modules` symlink behind — delete both.
- GUI `http://127.0.0.1:3080`; DSH checkout
  `/home/user/.npm/_npx/c8633a242642d858/` (`0.2.1-rc.2`).
- Payload: `state, live, online, metricsEnabled, servedModel, servedModelMatches,
  props, pollMs, progressLive[], metrics, slots, debug{contextTrace, effortTrace,
  request}`. `online` is always present; `slots`/`metrics` only on `live:true`;
  `state:"unauthorized"` reports a missing/rejected credential.
  `progressLive` entries carry `id, sessionId, provider, model, phase, purpose,
  decoded, sessionKind/Label, startedAt, taskStartedAt, endedAt, outcome,
  promptTps, decodeTps`. `slots` is `{total, processing, ctxTokens, ctxMax,
  ctxPercent, rows[{id, active, phase, nCtx, ctxLen, processed, cache, decoded,
  speculative, decodeTps}]}`. `metrics` is the curated summary (`decodeTps,
  promptTps, cacheHitPercent, predictedTotal, promptTotal, cachedPromptTotal,
  promptSecondsTotal, decodeSecondsTotal, requestsProcessing, requestsDeferred,
  specAcceptPercent, specAcceptedTokens, specDraftSteps, nBusySlotsPerDecode,
  nTokensMax, rawTotal, raw[]`), rendered as a headline, five facts and the raw
  samples in a `<details>`.
