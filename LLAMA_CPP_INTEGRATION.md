# llama.cpp changes that would improve DSH integration

This document lists improvements that could be made in llama.cpp (or its
OpenAI-compatible server) to make the DSH provider adapter simpler, more
accurate, and less dependent on probes and workarounds.

These are upstream opportunities, not requirements for the current adapter.
Each item lists the current behavior, a proposed interface, why it matters, and
the workaround the adapter uses today.

## 1. Per-image visual-token accounting

**Current behavior:** `usage.prompt_tokens` includes image chunk tokens, but
llama.cpp exposes only the combined prompt total. There is no per-image or
image-vs-text breakdown.

**Proposal:** add image token accounting to the request response and tokenizer:

- `usage.prompt_tokens_details.image_tokens` for the total visual tokens.
- An ordered per-image breakdown, for example
  `usage.prompt_tokens_details.images: [{ index, tokens }]`.
- The same fields in the final streaming usage frame.
- `/tokenize` support for image messages, returning both the total and the
  per-image token counts.

**Why it matters:** DSH's `imageRequestPricing` must return a visual-token count
per image occurrence *before* a request is measured. Without a public count, the
token meter uses a small fixed reference heuristic until provider usage anchors
the completed request. That can underestimate image-heavy context pressure.

**Current workaround:** `imageRequestPricing` stays undefined; completed-request
usage includes image tokens and remains authoritative.

## 2. Native mid-conversation tool updates

**Current behavior:** tools are declared by the request-level `tools` array.
Changing tools between turns works because DSH resends the complete current
list, but the declaration prefix changes and the KV cache is invalidated. There
is no native deferred-tool activation.

**Proposal:** support a stable tool declaration series:

- Accept `defer_loading` / deferred declarations and activate them with a later
  developer or system tool-addition message.
- Accept tool-removal updates without rewriting the original declarations.
- Keep the tool parser aware of newly activated tools so calls produce valid
  `tool_calls` results.
- Expose capability flags such as
  `chat_template_caps.supports_mid_convo_tool_additions` and
  `supports_mid_convo_tool_removals`.
- Alternatively, accept an explicit `tools_delta` request field with
  `added`/`removed` entries and retain the declaration list across turns.

**Why it matters:** DSH's `toolUpdate: "addition-only"` and `"in-history"` modes
let dynamic tools, including MCP tools, follow cached history instead of
rewriting the tool block. Without native support, the adapter must send the
complete list every turn and cannot preserve deferred loading.

**Current workaround:** no `toolUpdate` advertisement; the complete current tool
list is sent every request. Ordinary additions and removals work; deferred
loading does not.

## 3. Chat-template and reasoning capability introspection

**Current behavior:** templates differ on whether they accept a leading system
message, a mid-history system message, or the `developer` role, and some require
strict user/assistant alternation. The adapter discovers this by probing
`/apply-template` and folding system content into user turns.

Reasoning modes are also discovered by probing: the adapter posts an invalid
`reasoning_effort` value to `/apply-template` and parses the resulting exception
text for phrases such as `Supported types are …`, `Supported values: …`, or
`should be …`. A template that accepts effort without enumerating it falls back
to a standard level list. This probe intentionally generates a server error on
every catalog refresh.

**Proposal:** expose explicit template and reasoning capabilities in `/props` or
`chat_template_caps`, for example:

- `supports_leading_system`
- `supports_mid_history_system`
- `maps_developer_to_system`
- `requires_role_alternation`
- `supports_tools`
- `supports_tool_updates`
- `reasoning.supported`
- `reasoning.control` (`reasoning_effort` or `enable_thinking`)
- `reasoning.supported_levels`
- `reasoning.default_level`
- `reasoning.off_value`
- `reasoning.requires_explicit_level`

**Why it matters:** reasoning discovery currently depends on exception wording,
which is not a stable API. It produces an error log on every refresh, cannot
enumerate a template that validates the value without listing alternatives, and
breaks if the template’s error text changes. A declared capability would make
the offered levels deterministic and remove a class of false negatives.

**Current workaround:** probe `/apply-template` for leading-system support and
reasoning levels, merge leading system messages, fold later system updates into
the next user turn, and keep the last known answer when a probe is inconclusive.

## 4. Session-aware slot affinity

**Current behavior:** an unpinned request is assigned a slot by prompt
similarity. With `--slot-prompt-similarity` defaulting to `0.1`, concurrent
sessions that share a system prompt and tools can steal each other's slot and
discard the slot's KV cache. `id_slot` can pin a request, but the server does not
assign or remember a session identity.

**Proposal:** add a stable session-affinity mechanism:

- A request-level `session_id` (or equivalent) that the server maps to a slot and
  remembers across turns.
- Return the assigned slot in the response or usage metadata.
- Expose slot affinity and cache ownership in `/slots`.
- Optionally provide an explicit `slot_affinity` policy or a server flag for
  session-stable assignment.

**Why it matters:** DSH currently maintains a provider/session-to-slot map and
must protect active sub-agent slots from LRU reuse. A server-side affinity key
would make the behavior consistent for every client, not just this adapter.

**Current workaround:** the adapter sends `id_slot` with a per-session assignment
derived from `/props.total_slots`, reuses idle assignments when the pool is full,
and protects in-flight sessions.

## 5. Prompt-cache and usage diagnostics

**Current behavior:** usage reports `prompt_tokens_details.cached_tokens`, and
`/slots` reports aggregate cache/context data. It does not report which slot
served a request, whether the prompt cache was hit or evicted, or how cache
tokens map to images.

**Proposal:** include in the final usage or response metadata:

- `id_slot` actually used.
- Cache read/write and eviction indicators.
- `cached_tokens` and `image_tokens` as separate fields.
- Optional per-request prompt-prefix/cache identity for diagnostics.

**Why it matters:** DSH's pill and dialog currently infer slot ownership from
slot counters and client-side request tracking. Native metadata would make
cache behavior observable without guessing.

**Current workaround:** the adapter pins slots itself and the UI correlates
requests from its own SSE progress state.

## 6. Reasoning-token usage details

**Current behavior:** reasoning is streamed and can be replayed as
`reasoning_content`, but usage does not separate reasoning tokens from visible
completion tokens.

**Proposal:** add
`usage.completion_tokens_details.reasoning_tokens` (and optionally cached
reasoning tokens) to match other OpenAI-compatible providers.

**Why it matters:** DSH token accounting and compaction can distinguish what was
charged for hidden reasoning from what is actually visible in the conversation.
This is most useful when reasoning is not replayed after a model switch.

**Current workaround:** the adapter preserves reasoning in the wire history where
the model accepts it, so usage naturally includes it, but the UI cannot show a
separate reasoning-token count.

## 7. Clear context metadata

**Current behavior:** `/v1/models` `meta.n_ctx` is the loaded context, while
`n_ctx_train` is the model's training context. The distinction is easy to
misread, and `/props` is the more reliable source for the loaded per-slot
context.

**Proposal:** expose explicitly named fields, for example:

- `meta.n_ctx_loaded`
- `meta.n_ctx_train`
- `meta.n_ctx_slot`
- `meta.n_ctx_per_request` when applicable

**Why it matters:** DSH must decide which window to use for compaction. Ambiguous
metadata has already caused an incorrect comment and test assumption in this
repository.

**Current workaround:** prefer `/props` loaded context, fall back to
`/v1/models` `meta.n_ctx`, and document that it is not the training context.

## 8. Prefix-only slot-cache saves

**Current behavior:** `POST /slots/{id}?action=save` serializes the slot's full
KV allocation. On `devbox.local` with q8 KV and 262K slots, a 9,856-token prefix
produced a 659 MB file despite containing only 9,856 cached tokens. Restore
worked and reduced a cold 25.9 s prefill to 198 ms plus a 116 ms restore, but the
file size does not scale down with the prefix.

**Proposal:** allow a prefix-only or compressed save format, or report the
prompt-prefix portion separately from the allocated KV state. Expose the save
size and whether a prefix can be restored into a different slot.

**Why it matters:** seeding system prompts and tool definitions into new
sessions can remove tens of seconds of prefill, but 659 MB per seed is too heavy
to make automatic. A prefix-only format would make this practical on home
servers with large contexts.

**Current workaround:** compaction reuses the session slot, which needs no save
file. New-session seeding remains an explicit opt-in with a disk-space policy.

## 9. Context-checkpoint control and diagnostics

**Current behavior:** each slot keeps up to `--ctx-checkpoints` in-memory
checkpoints (default 32, minimum spacing `--checkpoint-min-step` 8192 tokens).
They are created at user-message starts and near prompt end, and restored when
SWA/hybrid/recurrent memory cannot rewind to the common prefix. They are included
in a slot save file, but there is no HTTP endpoint to create, inspect, or restore
an individual checkpoint. On Qwen3.8 with q8 KV and 262K slots, one checkpoint
measured 112.571 MiB; four existed at 20K tokens. The default 32 therefore allows
about 3.6 GiB per slot. `--cache-ram` bounds the idle-slot prompt cache (whose
stored states include checkpoints), not the active slot's checkpoint list.

**Why it matters:** DSH pruning can cut a conversation at a tool-call or
assistant boundary. For a hybrid model such as Qwen3.8 (`qwen35` with SSM/recurrent
layers), a checkpoint before that boundary can avoid reprocessing the surviving
prefix; without one, llama.cpp may force a full prompt reset. A live test resumed
a pruned prompt from a user-turn checkpoint with 11,038 cached tokens and only 21
new. A disk slot save is the wrong tool for this because it serializes the full
KV allocation (659 MB in the measured 262K Qwen slot).

**Proposal:**

- expose the checkpoint policy, count, and sizes in `/props`/`/metrics`;
- allow a client to create and lease an in-memory checkpoint at a message or
  tool-call boundary, then restore/erase it through a small HTTP API;
- create checkpoints at assistant/tool boundaries, not only user-message starts
  and prompt end;
- keep checkpoint ownership tied to the slot/session so pruning can resume from
  the boundary without a full reprocess;
- make memory pressure explicit: a server with a small `--cache-ram` should be
  able to set `--ctx-checkpoints`/`--checkpoint-min-step` without sacrificing the
  exact boundary it needs.

**Current workaround:** keep pruning and compaction on the session’s own slot so
its checkpoints survive; rely on the default user-start checkpoints. The plugin
cannot create or query them. On memory-limited servers, budget
`--ctx-checkpoints` explicitly: lowering the count reduces memory but covers less
history; lowering `--checkpoint-min-step` gives finer recent boundaries but does
not create tool-call checkpoints, and with a fixed count it shortens history
coverage.

## 10. Media markers in ordinary text

**Current behavior:** llama.cpp generates a random `media_marker`
(`<__media_<random>__>`, or `LLAMA_MEDIA_MARKER` when pinned) and exposes it in
`/props`. On the OpenAI-compatible chat path with an mmproj loaded, the server
always runs the rendered prompt through `process_mtmd_prompt`, even when the
request has no media inputs. `mtmd_tokenize` splits that prompt on the marker and
treats every occurrence as an image slot; one marker with zero bitmaps throws,
and the request fails with HTTP 400 `Failed to tokenize prompt`. A text message
or tool result that contains the marker is enough — no image is involved. A
normal `/props` inspection is therefore self-poisoning: the tool result echoes
the marker, and the next turn cannot be tokenized.

**Why it matters:** `/props` is a supported introspection endpoint; a client or
agent that reads it should not be unable to continue its own conversation. A
retry that resends the same text fails again, and the error looks like an image
or template problem even though the prompt is text-only. Any OpenAI-compatible
client can hit it; it is not adapter-specific.

**Proposal:** stop treating the marker string inside plain text as a media
placeholder. Escape marker occurrences in text content before chat-template
rendering (for example, insert a zero-width character inside the marker) or
tokenize from typed parts rather than splitting the rendered prompt. Also
consider not returning the raw marker from `/props` by default, or returning it
only behind an explicit opt-in, so ordinary introspection does not expose the
server's sentinel. When the collision does occur, a 400 should name the
marker-in-text condition explicitly instead of only saying `Failed to tokenize
prompt`.

**Current workaround:** the plugin reads `media_marker` from `/props` while
assembling the model catalog and, before every chat request, inserts a
zero-width space after the first character of any exact occurrence in the
request body's string values. The text renders the same but no longer matches
the server's sentinel. The rewrite covers messages, tool results, tool
declarations, and reasoning.

## Priority

1. Per-image visual-token accounting and mid-conversation tool updates: direct
   feature gaps for DSH integrations.
2. Template and reasoning capability flags: removes probing and makes
   compatibility and offered levels explicit.
3. Session-aware slot affinity: makes cache ownership correct for all clients.
4. Context-checkpoint API and prefix-only slot saves: enables pruning and
   new-session seeding without full reprocessing or huge disk files.
5. Media-marker text handling: prevents text-only history from failing when a
   tool result echoes the server's marker; small upstream fix, client-side
   workaround in place.
6. Prompt-cache, reasoning, and context metadata: improves observability and
   token accounting but is less critical for correctness.
