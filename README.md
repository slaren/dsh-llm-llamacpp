# dsh-llm-llamacpp

A Cordis plugin for **DeepSeek Harness** that adds one or more **llama.cpp**
servers as model providers and shows this session's live prompt and decode
progress in the composer dock.

> Private package: not published to npm. Tested with DSH `0.2.x` and a current
> `llama-server` build.

## Features

- **Declared routes, no interception.** Every key in `servers` becomes a
  provider route with its own `baseURL`, optional `alias`, and optional
  credential reference. Nothing is auto-discovered or rewritten.
- **Settings → Models integration.** Add and edit servers from the Models page;
  each row shows a green/red reachability dot. Removing a route is a hand edit
  of the `servers` map.
- **Live discovery.** Models come from `/v1/models`; loaded context, output cap,
  and modalities come from `/props`; reasoning levels come from the server's
  own `/apply-template` list.
- **Dock pill and dialog.** Prompt progress with ETA, current prompt/decode
  tok/s, per-slot context and KV use, cache hit rate, and the raw server
  metrics.
- **Warm caches under concurrency.** Sessions are pinned to a stable llama.cpp
  slot, and idle slots are reused without evicting active conversations.
- **Streaming parity.** Retryable failure codes, assistant reasoning replay,
  image handling, parallel tool calls, and disjoint usage accounting match the
  stock pi-ai route.
- **Headless-friendly.** Routes, discovery, and streaming work without a web
  server; the pill and dialog simply do not mount.

## Requirements

- DeepSeek Harness `0.2.x`.
- `llama-server` with the OpenAI-compatible API. `/props` supplies model and
  context facts, `/apply-template` supplies reasoning levels, and `/metrics` and
  `/slots` supply the live server readings.

## Launching llama.cpp

Start `llama-server` with the flags that expose the readings this plugin shows:

```sh
llama-server \
  -m /path/to/model.gguf \
  --host 127.0.0.1 --port 9931 \
  --metrics --slots --jinja
```

- `--metrics` enables `/metrics`: throughput, prompt-cache hit rate, speculative
  decoding, and the server counters in **All metrics**. It is optional — the pill
  and **Server slots** still work without it — but without it the All metrics
  section only says that metrics are disabled.
- `--slots` enables `/slots`, which feeds **Server slots** and the session-context
  line. Current builds enable it by default; do not pass `--no-slots` unless you
  accept losing those readings. If `--metrics` is also off, the dialog then has
  no server readings at all: only the pill's own SSE progress remains.
- `--jinja` uses the model's Jinja chat template, which reasoning and tool calls
  depend on. Current builds enable it by default; add it explicitly if your build
  disables Jinja or you pass `--no-jinja`.
- `--api-key` is optional. If you use it, store the same key in the DSH provider
  card.
- `-np` above 1 lets concurrent sessions keep separate slots, and `-c` sets the
  context window. The plugin reads both from `/props`; neither is configured in
  DSH.

`--props` is not required: the plugin only reads `/props` with GET, and that flag
only enables `POST /props`.

## Install

Install the bundle directly from GitHub. Open **Settings → Plugins** and install
from the GitHub spec below, or call `plugin_manager` with `action:
install_bundle` and:

```text
github:slaren/dsh-llm-llamacpp
```

The HTTPS form works too: `https://github.com/slaren/dsh-llm-llamacpp`. The
manager installs the package and its dependencies, selects the bundle, and
applies the bundled `cordis.patch.yml`. Restart the host if DSH reports that a
restart is required.

### Command line

The same install from a shell, using `npx`:

```sh
npx @deepseek-ai/dsh plugin --profile web add github:slaren/dsh-llm-llamacpp
```

`web` is the profile to install into; substitute another profile name when
needed. If `dsh` is already on your `PATH`, use `dsh plugin ...` instead of
`npx @deepseek-ai/dsh plugin ...`.

For local development, clone the repository and install the checkout by path
instead:

```sh
git clone https://github.com/slaren/dsh-llm-llamacpp.git
cd dsh-llm-llamacpp
npm install
```

Then pass the absolute path (for example `link:/path/to/dsh-llm-llamacpp`) to
`install_bundle`. A host-side change needs a plugin reload; client changes
appear after a page refresh.

## Configure

1. Open **Settings → Models → Add model provider** and choose **llama.cpp (new
   server)**.
2. Enter the full API base URL, for example `http://127.0.0.1:9931/v1`.
   A bare `host:port` is rejected.
3. Optionally set an alias and an API key (stored as a DSH credential
   reference) for servers started with `--api-key`. No secret is stored in the
   plugin config.

Or declare routes directly in the profile patch:

```yaml
- insert:
    - id: dsh-llm-llamacpp
      name: dsh-llm-llamacpp
      config:
        servers:
          llamacpp-local:
            alias: local
            baseURL: http://127.0.0.1:9931/v1
            apiKeyEnv: LLAMACPP_LOCAL_API_KEY
```

Model ids, context window, output cap, and reasoning levels are read from the
server, never configured here.

## Usage

While a request is streaming, the pill shows progress such as
`prompt 250/1K (25%) · ETA 5s · 100 tok/s`, then
`decode · 226 tok · 44 tok/s`. Click it for the Live progress, Server slots, and
All metrics sections; collapsed sections keep their headline and persist the
preference in `localStorage`.

## Development

```sh
node --check index.js client.js
node test/client-test.mjs
node test/parity-test.mjs
LLAMA_CPP_BASE=http://127.0.0.1:9931/v1 \
LLAMA_CPP_MODEL=<model-id> node test/host-test.mjs
```

`test/template-test.mjs` is an optional live matrix that starts `llama-server`
with different chat templates. See [`AGENTS.md`](AGENTS.md) for architecture and
invariants, [`LLAMA_CPP_INTEGRATION.md`](LLAMA_CPP_INTEGRATION.md) for upstream
proposals, and [`CREDITS.md`](CREDITS.md) for the llama.brand attribution.

## Notes

- The plugin does not start or manage `llama-server`.
- Telemetry endpoints are optional; the dialog degrades when they are absent.
- Not affiliated with or endorsed by ggml-org.

## License

The plugin code is released under the [MIT License](LICENSE).

The llama.brand mark in `icon.svg` and in the client's pill and dialog title is
third-party artwork. It is not relicensed by MIT; see [CREDITS.md](CREDITS.md)
for its license and the brand-usage grant.
