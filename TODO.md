# llama.cpp Provider — remaining work

## Tasks

- [ ] **Store the API key before committing the settings write.** The card's save
  path commits the profile (with its `apiKeyEnv` reference) and only then calls
  `setKey` (`client.js`, `ServerForm.save`); a refused key store leaves the route
  pointing at a credential that resolves to nothing, so every later request to
  that route fails with `MISSING_CREDENTIAL` until the row is edited again.
  Store the key first, or unset `apiKeyEnv` when the key store fails.

- [ ] **Remember the last reasoning effort per model.** Store the effort the user
  last selected for a `provider|model` pair and make it the default when that
  model is selected again, instead of falling back to the template default.
  An explicit selection updates the memory; a model that disappears must not
  leak its effort to another model. Decide whether the memory is per profile or
  per session, and keep a stale level from being sent when the server no longer
  advertises it (`UNSUPPORTED_REASONING_EFFORT` fallback).

## Tasks to consider

- [ ] **Expose slot affinity in the UI.** Add the assigned `id_slot` to
  `progressLive` and `/config`, show it in the live table, and flag requests that
  are unpinned. Today slot ownership is inferred from `/slots` counters, so cache
  behavior and pool exhaustion are harder to diagnose. The adapter owns the id it
  sends, so publishing it also lets the client drop the fragile counter-based
  `matchSlots` join (rows matched on cached-prefix length + context growth).

- [ ] **Make slot affinity model-aware.** The current key is
  `provider|sessionId`, so a model switch on the same route reuses the old slot
  mapping. Include the model in the key, or drop the assignment on a model
  change, so a new model does not inherit a KV cache belonging to another model.

- [ ] **Prioritize interactive sessions over sub-agents.** `sessionProjections`
  already identifies sub-agents. When the slot pool is full, prefer ordinary
  conversation sessions; sub-agents are shorter-lived and more numerous. The
  allocator currently cannot distinguish the two.

- [ ] **Add a per-route affinity toggle.** Some llama.cpp servers are shared with
  other clients. A route-level `sessionSlotAffinity: false` would let DSH use the
  server’s own slot selection when pinning would compete with other consumers.
  Keep the default enabled.

- [ ] **Detect `supports_preserve_reasoning`.** `/props.chat_template_caps`
  exposes this capability. If the template does not support preserved reasoning,
  replaying `reasoning_content` may be ignored and the token meter can
  overestimate. Surface a warning and adjust the reasoning-replay expectation
  instead of silently assuming it is preserved.

- [ ] **Support explicit reasoning budgets.** The server accepts
  `thinking_budget_tokens`/`reasoning_budget_tokens` (the Anthropic-compatible
  endpoint maps `thinking.budget_tokens` to it). Add support if DSH exposes a
  reasoning-token budget, with the budget passed through only when the template
  advertises reasoning support.

- [ ] **Improve upstream error detail.** Preserve a short server message excerpt
  for 400/422 template errors and context-overflow cases, so users can see which
  template or tool declaration failed instead of receiving only a generic
  adapter error.

- [ ] **Show cache effectiveness per request.** Add cached-token counts and hit
  percentage to live rows, not only the aggregate metrics dialog. This makes it
  easy to confirm that slot pinning and prompt-prefix changes are helping.

- [ ] **Expose per-route retry policy.** The adapter deliberately uses the
  Harness normal-retry default. If users need longer retries for a slow remote
  llama.cpp server, add an advanced `retryPolicy` profile field; otherwise keep
  the default documented as final.

- [ ] **Persist slot assignments across plugin reloads.** Reloading the host
  plugin clears in-memory mappings while the server’s KV caches survive.
  Persisting assignments in session state or the profile would preserve affinity
  across a reload.

- [ ] **Use slot save/restore to seed new sessions.** With `--slot-save-path`,
  process the system prompt and tool definitions once, save that slot cache to a
  file, and restore it into a new session’s slot so the shared prefix does not
  have to be processed again. This needs a stable name derived from the exact
  model + system prompt + tool-definition prefix, a capability check, and a
  fallback to a normal request; any prefix change invalidates the file. On
  `devbox.local` (q8 KV, 262K slots), a 9,856-token prefix cold-prefilled in
  25.9 s; after saving (659 MB, 207 ms) and restoring (116 ms) into a new slot,
  the request processed only 20 new tokens in 198 ms. The saved file is the
  slot’s full KV allocation and does not shrink with the prefix, so this needs
  an explicit opt-in, a disk-space policy, and ideally a prefix-only save API.

- [ ] **Use in-memory context checkpoints before prunable spans.** llama.cpp
  already keeps up to 32 in-memory checkpoints per slot (default minimum spacing
  8192 tokens), created at user-message starts and near prompt end, and restores
  one when a hybrid/SWA/recurrent state cannot rewind to the common prefix.
  Qwen3.8 is a `qwen35` hybrid model with SSM layers, so this path matters.
  A live test on `devbox.local` resumed a pruned prompt at a user-turn checkpoint:
  11,038 tokens cached, only 21 new. But each checkpoint was 112.571 MiB, so the
  default 32 would be ~3.6 GiB per slot; `-cram 4096` bounds the idle-slot prompt
  cache, not those active-slot checkpoints. Under this memory budget, set an
  explicit `--ctx-checkpoints`/`--checkpoint-min-step` budget rather than keeping
  the default, and keep pruning on the same slot so checkpoints survive. Do not
  add disk snapshots by default. Verify whether DSH pruning cuts at user
  boundaries; if it cuts inside a run of tool calls, request upstream
  creation/exposure of checkpoints at assistant/tool boundaries, since lowering
  the spacing does not create those checkpoints.

- [ ] **Verify router / multi-model behavior.** Confirm slot IDs remain
  meaningful when one llama.cpp router serves multiple models. The model-aware
  affinity key above is the minimum fix; a router-specific test would confirm the
  behavior.

- [ ] **Consume `chat_template_caps` instead of treating every template as
  unknown.** `/props.chat_template_caps` exposes system-role support, reasoning
  effort, parallel tool calls, and preserve-reasoning support. Use the flags to
  skip impossible probes (especially reasoning effort), send
  `parallel_tool_calls`/`preserve_reasoning` only when supported, and keep
  `/apply-template` only for enumerating the actual effort levels. Verified on
  `b11803`: the caps map carries `supports_system_role`,
  `supports_preserve_reasoning`, `supports_reasoning_effort`, and
  `supports_parallel_tool_calls` (`common/jinja/caps.h:10-27`), and
  `parallel_tool_calls` already defaults to the template's cap on the OAI route
  (`server-common.cpp:1442`). The leading-system probe is actively misleading and
  should be replaced by `supports_system_role`: `/apply-template` runs the
  server's own system-message merge before rendering
  (`common/chat.cpp:1353`, `system_message_not_supported` at `:1001-1017`), so an
  effective 200 cannot show whether the raw template accepts the role. Keep the
  probe only as the fallback for builds that do not report the flags.

- [ ] **Distinguish loading, sleeping, and unreachable servers.** Use the public
  `/health` endpoint (503 loading, 200 ready) and `/props.is_sleeping` to show
  “loading model”, “sleeping”, and “waking” states instead of a generic
  unreachable route. This avoids misleading errors during startup and sleep.
  Verified: `/health` and `/v1/health` stay public even with `--api-key`
  (`server-http.cpp:252-259`), and while a model loads every endpoint answers
  503 `unavailable_error` "Loading model" (`server-http.cpp:308-326`) — so even
  an unauthorized route (missing or rejected credential) can still prove the
  server is up: 200 on `/health` plus 401 on `/props` means "up, wrong
  credential", distinct from "down" and "loading". `/props` and `/v1/models`
  also answer from a cache while sleeping (`is_sleeping: true`), so an
  unauthenticated-looking probe can be a sleeping server rather than a hostile
  one.

- [ ] **Filter models by output modality.** `/v1/models` now exposes
  `architecture.output_modalities`. Do not offer TTS-only or decision-only models
  in the chat provider group; they cannot serve this adapter’s requests.

- [ ] **Use the input-token endpoint for preflight and image pricing.**
  `/v1/chat/completions/input_tokens` (and the Anthropic-compatible
  `/v1/messages/count_tokens`) counts the rendered prompt, including multimodal
  chunks. It can serve as a context preflight and, if counts are prefetched and
  cached by image identity, provide exact visual-token data for
  `imageRequestPricing` (the pricing hook itself is synchronous). Verified:
  `handle_count_tokens` runs the mtmd tokenize path on vision builds
  (`process_mtmd_prompt(...).size()`), so image chunks are included in the
  total — but it is a single total, with no per-image breakdown.

- [ ] **Expose slot saturation.** `GET /slots?fail_on_no_slot=1` returns 503 when
  every slot is busy. Use it to show “all slots busy” rather than treating the
  missing slots payload as unavailable.

- [ ] **Consider reasoning-end control.** `reasoning_control` plus
  `POST /v1/chat/completions/control` can force the current reasoning block to
  end while generation continues. Expose it only if the dialog gains an explicit
  “stop thinking” action.

- [ ] **Use router model-management endpoints.** Router mode exposes
  `/models/load`, `/models/unload`, and `/models/sse`. These could support a
  future preload/unload UI or keep the model picker’s catalog current without
  polling.

- [ ] **Show training context and model facts.** `/v1/models` exposes
  `meta.n_ctx_train`, `n_vocab`, `n_params`, `size`, and `ftype`, while the UI
  currently shows only the loaded context. These are useful diagnostic facts in
  the model picker or dialog.

- [ ] **Pass `preserve_reasoning` explicitly when supported.** The server
  defaults it on when the template supports it, but a deployment may launch with
  a different policy. Send it through `chat_template_kwargs` only after checking
  `supports_preserve_reasoning`; otherwise leave the server policy alone.
  Verified launch flags: `--reasoning-preserve` / `--no-reasoning-preserve`
  (`server-context.cpp:1715-1735`).

- [ ] **Dedupe and throttle forced re-probes.** The `/live` `retry=1` path probes
  upstream on every call with no in-flight dedupe (only `liveSnapshot` uses the
  `inflight` map), and while a route is unhealthy the pill forces `retry=1` on
  every poll at `clientPollMs` (seeded 500 ms) while the global availability
  watcher fires one forced probe per route every 15 s from every open tab — a
  down server with several tabs sees a sustained overlapping probe stream.
  Dedupe `retry=1` probes per origin, add a minimum probe interval (2–5 s), add
  client-side backoff while unhealthy, and consider seeding `clientPollMs` at
  1000–2500 ms (the host's own fallback is already 2500).

- [ ] **Prune slot assignments when the pool shrinks.** llama.cpp wraps an
  out-of-range `id_slot` (`id_slot % slots.size()`, `server-context.cpp:1744-1745`)
  instead of rejecting it, so after a server restarts with a smaller `-np` a
  stale pin silently lands on a different slot. Drop an assignment when its slot
  id reaches the current `total_slots`, and sweep assignments idle beyond a TTL
  (`byTask` currently shrinks only by eviction-on-full).

- [ ] **Do not promise "no eviction" for auxiliary calls.** AGENTS' "session-title
  calls use a free unassigned slot without evicting a conversation" is stronger
  than the server guarantees: an unassigned request goes through the
  LCP-similarity scan, which considers *idle* slots — an idle conversation slot
  with a matching prompt is selected and overwritten, and its old cache is saved
  only when the retention fraction drops below 0.5 (`get_available_slot`,
  `server-context.cpp:1789-1836`). A title prompt diverges from its session's
  cached prefix, so on a full pool the next unpinned title call can evict that
  conversation's cache. Either pin title calls to the session's own slot (the
  compaction rationale) or drop the "without evicting" wording.

- [ ] **Attach the pill to the server's resumable stream.** llama.cpp tees the
  stream of any request carrying an `X-Conversation-Id` header into a server-side
  ring buffer that survives client disconnects; `GET /v1/stream?conv_id=…`
  re-reads it from any offset and `POST /v1/streams/lookup` reports liveness for
  known ids (`server-stream.h:12, 52-58`; `server-stream.cpp:613`). This softens
  the plugin's founding premise (progress exists only in a stream this process
  dispatched): after a page reload mid-turn, the client could re-attach directly
  to llama.cpp's replay buffer and restore the pill without the host progress
  cache. Document this in AGENTS' "How it works" and `LLAMA_CPP_INTEGRATION.md`,
  and evaluate a pill that reattaches by conv id (e.g. `provider|sessionId|seq`).

- [ ] **Filter `progressLive` by the polled origin and strip internal fields.**
  `liveProgress()` hands every provider's rows (and internal fields such as
  `labelAt`) to any `?provider=X` poll; filter by the polled origin and project
  each entry to the documented payload shape.

- [ ] **Probe `/props` and `/metrics` in parallel.** `probeOrigin` fetches
  `/metrics` only after `/props` returns, but only `metricsEnabled` depends on
  `/metrics`; one round trip is wasted on every probe.

- [ ] **Correct the finish-reason wording in the docs.** AGENTS implies the
  server emits `content_filter`/`network_error`; the current source only emits
  `length`/`stop`/`tool_calls` (partial frames carry `null`), and a mid-stream
  server failure arrives as an `{"error": …}` frame inside the 200 stream, which
  the adapter already throws on (`server-context.cpp:5334-5344`,
  `server-task.cpp:374-420`). Keep the defensive mapping; fix the phrasing.

- [ ] **Document that image prompts disable checkpoints.** Checkpoint creation is
  skipped once the prompt contains mtmd chunks
  (`do_checkpoint && !has_mtmd`, `server-context.cpp:4442`), so vision-heavy
  sessions rely purely on SWA/normal rewind; add a caveat to the checkpoint
  sections.

- [ ] **Retire dead compatibility paths.** The `llama_cpp_*` metric-name family
  and the nested `slot.i` counter fallback match no current build (all metrics
  are `llamacpp:*`; slot counters are flat with `n_prompt_tokens_processed` /
  `n_prompt_tokens_cache`, `server-context.cpp:793-826`). Harmless today; drop
  them once the baseline build is declared.

- [ ] **State the runtime floor.** `AbortSignal.any` (the stream-header abort
  race, `index.js`) requires Node ≥ 20.3 and a modern browser fetch; document
  the floor in AGENTS instead of leaving it implicit.

- [ ] **Make the server removable from the GUI.** The provider card can edit
  every field but not delete a route; removal means hand-editing the patch
  file's `servers` map. Add a "Remove server" action writing an unset of
  `['servers', <route>]` so a declared route can be retired from the page.

- [ ] **Make the suites runnable read-only; add `npm test`.** Both generated-copy
  suites `writeFileSync` a patched module inside the package
  (`test/parity-test.mjs:49-50`), so they fail with `EROFS` on a read-only
  checkout (verified) and dirty the worktree on every run, and they race under
  parallel test runs. Decouple via an injectable `fetch`/probe seam or a
  generated copy in `os.tmpdir()` with a `node_modules` symlink. `package.json`
  has no `scripts` at all — add `"test": "node test/client-test.mjs && node
  test/parity-test.mjs"` so CI and the harness have an entry point.

- [ ] **Add accessibility to the dialog and card.** The dialog has Escape and
  outside-click handling but no focus management (no focus trap, no restore to
  the pill on close), and the card row status uses the non-standard
  `aria-description` attribute, which is never announced — use `aria-label`,
  `title`, or visually hidden text instead.

## Done

- [x] **Report unavailable readings without calling the server offline.**
  `liveSnapshot` now keeps the confirmed `/props` verdict's `online:true` and
  returns null `slots`/`metrics` when those endpoints are disabled or unreadable,
  instead of returning `null` (which the handler rendered as `online:false`).
  `metricsEnabled` now reports the probe's capability, not whether one scrape
  succeeded, so a failed reading no longer tells the user to launch with
  `--metrics`. The dialog distinguishes "metrics disabled" from "metrics enabled
  but this reading is unavailable". Host coverage includes metrics-off/slots-on,
  both-off, and a failed metrics scrape.

- [x] **Add a user-facing README.** `README.md` covers the dock pill and dialog,
  GitHub and `npx` installation, the Settings → Models provider card, the
  `llama-server` launch flags, development commands, and licensing.

