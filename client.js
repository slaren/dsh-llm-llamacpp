/**
 * Client half of dsh-llm-llamacpp: an ambient pill in
 * `conversation.composer.dock` (after the activity/usage pills) that appears
 * when the Session's current model resolves to a llama.cpp server, and shows
 * live throughput, KV-cache and request readings.
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-llamacpp',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const NS = 'dsh-llm-llamacpp';

    const dict = {
      'pill.aria': 'llama.cpp server metrics',
      'pill.decode': 'decode · {count} tok · {tps} tok/s',
      'pill.decodeRate': 'decode · {tps} tok/s',
      'pill.prompt': 'prompt {done}/{total} ({percent}%)',
      'pill.eta': 'ETA {eta}',
      'pill.tps': '{tps} tok/s',
      'dialog.title': 'llama.cpp',
      'dialog.progress': 'Live progress',
      'dialog.noProgress': 'No requests in flight.',
      'live.inFlight': '{count} in flight',
      'live.promptingCount': '{count} prompting',
      'live.decodingCount': '{count} decoding',
      'live.col.what': 'what',
      'live.what.you': 'you',
      'live.what.chat': 'chat',
      'live.what.sessionTitle': 'title',
      'live.what.compaction': 'compaction',
      'live.starting': 'starting…',
      'live.doneCount': '{count} done',
      'live.state.done': 'done',
      'live.state.stopped': 'stopped',
      'live.state.failed': 'failed',
      'dialog.slots': 'Server slots',
      'dialog.noSlots': '/slots is unavailable — start llama-server with --slots.',
      'slots.col.slot': '#',
      'slots.col.state': 'state',
      'slots.col.context': 'context',
      'slots.col.progress': 'progress',
      'slots.state.prompt': 'prompting',
      'slots.state.decode': 'decoding',
      'slots.state.idle': 'idle',
      'slots.totalTitle': 'Summed token rate of every processing slot.',
      'slots.serverKv': 'server KV {used}/{max} ({percent}%)',
      'slots.session': 'session context {used}/{max} ({percent}%)',
      'slots.sessionBreakdown': '{prompt} prompt + {decoded} decoded',
      'slots.sessionTitle': 'Server KV covers every slot. Session context is this session\'s live slot, including tokens generated in the current step. The harness context pill is a next-prompt estimate, so it excludes in-flight generation and can read lower.',
      'dialog.metrics': 'All metrics',
      'dialog.noMetrics': 'The server reported no metrics samples.',
      'metrics.generating': 'generating',
      'metrics.cacheReuse': 'prompt cache',
      'metrics.processing': 'processing',
      'metrics.note': 'now {rate}',
      'metrics.off': 'metrics off',
      'metrics.unavailable': 'metrics unavailable',
      'slots.hint': '{busy}/{total} busy',
      'metrics.rawSummary': 'raw Prometheus samples ({count})',
      'metrics.rawSummaryOf': 'raw Prometheus samples ({count} of {total})',
      'metrics.row.prompting': 'prompting',
      'metrics.row.decoded': 'decoded',
      'metrics.row.speculative': 'speculative',
      'metrics.row.batching': 'batching',
      'metrics.row.context': 'context',
      'dialog.fetching': 'Reading /metrics and /slots…',
      'note.metricsOff': 'Metrics disabled — start llama-server with --metrics to see throughput.',
      'note.metricsUnavailable': 'Metrics are enabled, but this reading is unavailable right now.',
      'note.serving': 'Server currently serves {model}.',
      'note.offline': 'Server unreachable — no live readings right now.',
      'card.alias': 'Alias',
      'card.url': 'Server URL',
      'card.apiKey': 'API key',
      'card.keyStored': 'configured',
      'card.keyHint': 'Optional. Stored in DSH credentials as {ref}; needed only when llama-server was started with --api-key.',
      'card.keyStoredHint': 'A key is stored in DSH credentials as {ref}; leave this blank to keep it.',
      'card.advanced': 'Customized settings',
      'card.statusOnline': 'Server reachable',
      'card.statusOffline': 'Server unreachable or credential rejected',
      'card.statusChecking': 'Checking server…',
      'card.cancel': 'Cancel',
      'card.apply': 'Save',
      'card.saving': 'Saving…',
      'card.add': 'Add server',
      'card.loadFailed': 'Reading this plugin\'s settings failed:',
      'card.urlRequired': 'Enter the server URL.',
      'card.urlInvalid': 'Enter the full server URL including its API path, for example http://127.0.0.1:9931/v1.',
    };

    const css = [
      '.llamacpp-metrics-anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
      '.llamacpp-metrics-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;min-width:0;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer;overflow:hidden}',
      '.llamacpp-metrics-pill svg{flex:none;width:14px;height:14px}',
      '.llamacpp-metrics-pill:hover,.llamacpp-metrics-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.llamacpp-metrics-label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.llamacpp-metrics-panel{z-index:1100;box-sizing:border-box;position:fixed;width:max-content;min-width:min(300px,100vw - 24px);max-width:min(430px,100vw - 24px);max-height:calc(100vh - 24px);overflow-y:auto;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.llamacpp-metrics-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
      '.llamacpp-metrics-titleIcon{display:inline-flex;align-items:center;gap:6px;min-width:0}',
      '.llamacpp-metrics-titleIcon svg{width:14px;height:14px;flex:none}',
      '.llamacpp-metrics-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin:10px 0}',
      '.llamacpp-metrics-live{margin:0;padding:6px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);max-height:22vh;overflow-y:auto;scrollbar-width:thin;scrollbar-gutter:stable}',
      '.llamacpp-metrics-liveHeadRow,.llamacpp-metrics-liveRow{display:grid;grid-template-columns:minmax(4.5em,1.4fr) 5.4em minmax(0,1fr);gap:2px 8px;align-items:center;font-variant-numeric:tabular-nums}',
      '.llamacpp-metrics-liveHeadRow{position:sticky;top:0;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);padding-bottom:2px}',
      '.llamacpp-metrics-liveRow{color:var(--dsw-alias-label-tertiary);padding:1px 0}',
      '.llamacpp-metrics-liveRow[data-tone=prompt],.llamacpp-metrics-liveRow[data-tone=decode]{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.llamacpp-metrics-liveWhat{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.llamacpp-metrics-sectionHead{display:flex;align-items:center;gap:6px;width:100%;margin:0 0 4px;padding:0;background:0 0;border:0;font:inherit;color:var(--dsw-alias-label-primary);font-weight:500;text-align:start;cursor:pointer}',
      '.llamacpp-metrics-sectionHead:hover .llamacpp-metrics-sectionTitle{color:var(--dsw-alias-label-secondary)}',
      '.llamacpp-metrics-chevron{flex:none;display:inline-block;color:var(--dsw-alias-label-tertiary);transition:transform .12s ease}',
      '[aria-expanded=true]>.llamacpp-metrics-chevron,details[open]>summary>.llamacpp-metrics-chevron{transform:rotate(90deg)}',
      '.llamacpp-metrics-sectionTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.llamacpp-metrics-sectionHint{flex:1 1 auto;min-width:0;text-align:end;color:var(--dsw-alias-label-tertiary);font-weight:400;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.llamacpp-metrics{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover)}',
      '.llamacpp-metrics-stats{display:flex;align-items:flex-start;padding-bottom:8px;margin-bottom:6px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.llamacpp-metrics-stat{flex:1 1 0;min-width:0;padding:0 10px}',
      '.llamacpp-metrics-stat:first-child{padding-inline-start:0}',
      '.llamacpp-metrics-stat:last-child{padding-inline-end:0}',
      // border-l1 is 6% white in dark and vanishes on the card; l3 reads as a hairline.
      '.llamacpp-metrics-stat+.llamacpp-metrics-stat{border-inline-start:.5px solid var(--dsw-alias-border-l3)}',
      '.llamacpp-metrics-statValue{color:var(--dsw-alias-label-primary);font-size:15px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.llamacpp-metrics-statCaption,.llamacpp-metrics-statNote{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.llamacpp-metrics-statNote{font-variant-numeric:tabular-nums}',
      '.llamacpp-metrics-meter{height:4px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden;margin-top:6px}',
      '.llamacpp-metrics-meterFill{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-state-success-primary)}',
      '.llamacpp-metrics-meter[data-tone=warn] .llamacpp-metrics-meterFill{background:var(--dsw-alias-state-warn-primary)}',
      '.llamacpp-metrics-metricRow{display:grid;grid-template-columns:5.6em minmax(0,1fr);gap:2px 8px;padding:2px 0;font-variant-numeric:tabular-nums}',
      '.llamacpp-metrics-metricRow+.llamacpp-metrics-metricRow{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.llamacpp-metrics-metricLabel{color:var(--dsw-alias-label-tertiary)}',
      '.llamacpp-metrics-metricValue{color:var(--dsw-alias-label-primary)}',
      '.llamacpp-metrics-details{margin-top:8px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.llamacpp-metrics-details>summary{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);cursor:pointer;list-style:none}',
      '.llamacpp-metrics-details>summary::-webkit-details-marker{display:none}',
      '.llamacpp-metrics-details>summary:hover{color:var(--dsw-alias-label-secondary)}',
      '.llamacpp-metrics-raw{margin:0;padding:0 14px 0 0;list-style:none;max-height:38vh;overflow-y:auto;scrollbar-width:thin;scrollbar-gutter:stable;grid-template-columns:minmax(0,1fr) auto;gap:2px 16px;display:grid}',
      '.llamacpp-metrics-rawName{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.llamacpp-metrics-rawValue{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.llamacpp-metrics-note{margin-top:8px;color:var(--dsw-alias-label-tertiary)}',
      '.llamacpp-metrics-slots{margin:0;padding:6px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);max-height:38vh;overflow-y:auto;scrollbar-width:thin;scrollbar-gutter:stable}',
      '.llamacpp-metrics-slotSummary{display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.llamacpp-metrics-slotTotal{flex:none;color:var(--dsw-alias-label-secondary)}',
      '.llamacpp-metrics-slotHeadRow,.llamacpp-metrics-slotRow{display:grid;grid-template-columns:1.5em 5.6em minmax(5.8em,auto) minmax(0,1fr);gap:2px 8px;align-items:center;font-variant-numeric:tabular-nums}',
      '.llamacpp-metrics-slotHeadRow{position:sticky;top:0;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);padding-bottom:2px}',
      '.llamacpp-metrics-slotRow{color:var(--dsw-alias-label-tertiary);padding:1px 0}',
      '.llamacpp-metrics-slotRow[data-tone=prompt],.llamacpp-metrics-slotRow[data-tone=decode]{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.llamacpp-metrics-slotId{display:inline-flex;align-items:center;gap:3px}',
      '.llamacpp-metrics-dot{color:var(--dsw-alias-state-idle-primary)}',
      '[data-tone=prompt] .llamacpp-metrics-dot{color:var(--dsw-alias-state-warn-primary)}',
      '[data-tone=decode] .llamacpp-metrics-dot{color:var(--dsw-alias-state-success-primary)}',
      '[data-tone=failed] .llamacpp-metrics-dot{color:var(--dsw-alias-state-error-primary)}',
      '[data-tone=failed] .llamacpp-metrics-liveRow{color:var(--dsw-alias-label-secondary)}',
      '.llamacpp-metrics-slotCtx{text-align:right}',
      '.llamacpp-metrics-slotProgress{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.llamacpp-metrics-bar{display:inline-block;width:36px;height:5px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden;vertical-align:middle;margin-right:6px}',
      '.llamacpp-metrics-barFill{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-state-warn-primary)}',
      '.llamacpp-card-mount{display:contents}',
      '[data-llamacpp-hidden]{display:none!important}',
      'li[data-llamacpp-status] [class$="_rowIdentity"]::after{content:"";box-sizing:border-box;border-radius:50%;flex:none;width:8px;height:8px;display:inline-block;background:var(--dsw-alias-label-dimmed)}',
      'li[data-llamacpp-status=online] [class$="_rowIdentity"]::after{background:var(--dsw-alias-state-success-primary)}',
      'li[data-llamacpp-status=offline] [class$="_rowIdentity"]::after{background:var(--dsw-alias-state-error-primary)}',
      '.llamacpp-card{display:flex;flex-direction:column;gap:14px}',
      '.llamacpp-card-editor{border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);padding:14px 16px}',
      '.llamacpp-card-form{display:flex;flex-direction:column;gap:14px}',
      '.llamacpp-card-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.llamacpp-card-label{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}',
      '.llamacpp-card-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}',
      '.llamacpp-card-input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}',
      '.llamacpp-card-input::placeholder{color:var(--dsw-alias-label-dimmed)}',
      '.llamacpp-card-input:disabled{opacity:.6;cursor:default}',
      '.llamacpp-card-button{box-sizing:border-box;flex:none;height:36px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer;justify-content:center;align-items:center;display:inline-flex}',
      '.llamacpp-card-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.llamacpp-card-primary{box-sizing:border-box;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:14px;line-height:22px;cursor:pointer;justify-content:center;align-items:center;display:inline-flex}',
      '.llamacpp-card-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.llamacpp-card-primary:disabled,.llamacpp-card-button:disabled{opacity:.4;cursor:default}',
      '.llamacpp-card-actions{justify-content:flex-end;gap:8px;display:flex}',
      '.llamacpp-card-advanced{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px}',
      '.llamacpp-card-summary{border-radius:var(--dsw-radius-sm);cursor:pointer;width:fit-content;color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;margin-left:-4px;padding:2px 4px;font-size:12px;font-weight:500;line-height:18px;list-style:none;display:flex}',
      '.llamacpp-card-summary::-webkit-details-marker{display:none}',
      '.llamacpp-card-summary:before{content:"";border-bottom:1.5px solid;border-right:1.5px solid;width:5px;height:5px;transition:transform .12s;transform:rotate(-45deg) translate(-1px,-1px)}',
      '.llamacpp-card-advanced[open]>.llamacpp-card-summary:before{transform:rotate(45deg) translate(-1px,-1px)}',
      '.llamacpp-card-summary:hover{color:var(--dsw-alias-label-primary)}',
      '.llamacpp-card-summary:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}',
      '.llamacpp-card-advancedBody{flex-direction:column;gap:12px;padding-top:12px;display:flex}',
      '.llamacpp-card-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.llamacpp-card-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
    ].join('');

    /**
     * The official llama.brand mark, unaltered: two paths on the asset's own
     * 600x600 canvas, rendered in one colour so the pill's label colour carries
     * it (`https://github.com/ggml-org/llama.brand`, CC BY-NC 4.0 with permission
     * for rescaling and monochrome rendering — see CREDITS.md).
     */
    function Icon() {
      return h('svg', { viewBox: '0 0 600 600', width: 16, height: 16, 'aria-hidden': true, fill: 'none' },
        h('path', {
          fill: 'currentColor',
          d: 'M600 392L504.249 558L504.137 557.929C487.252 584.069 458.193 600 426.864 600H120L240 392H600Z',
        }),
        h('path', {
          fill: 'currentColor',
          d: 'M240 392H0L199.602 46.0254C216.032 17.5463 246.411 3.25756e-05 279.29 0H466.154L240 392Z',
        }));
    }

    function compact(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return null;
      if (n >= 1e6) return (Math.round((n / 1e6) * 10) / 10) + 'M';
      if (n >= 1e3) return (Math.round((n / 1e3) * 10) / 10) + 'K';
      return String(Math.round(n));
    }

    /** Prometheus sample value as a compact readable number. */
    function fmtValue(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
      if (Number.isInteger(value)) return value.toLocaleString('en-US');
      return (Math.round(value * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
    }

    /** Unplaced dialog: laid out off-screen so the measure pass sees real size. */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };
    /** Same seat as the built-in dock pills: dialog above the pill, 8px gap, 12px margin. */
    const PANEL_GAP = 8;
    const PANEL_MARGIN = 12;
    /** Own-progress freshness window; must exceed the longest server prompt batch. */
    const LIVE_WINDOW_MS = 15000;
    /**
     * How far a slot may be ahead of its last SSE event: one batch iteration's
     * tokens. `/props` exposes no `n_batch`, so this is a floor, scaled per row by
     * the slot's own rate over a generous event interval. Exceeding the window
     * only costs a row its percentage, never its correctness.
     */
    const SLOT_MATCH_TOLERANCE = 512;
    const SLOT_EVENT_SECONDS = 6;

    /** A request the host has finished but not yet dropped (it holds for a moment). */
    function endedProgress(entry) {
      return entry !== null && typeof entry === 'object' && typeof entry.endedAt === 'number';
    }

    /**
     * Progress entries for this payload's provider.
     *
     * @param includeEnded - also take requests that just finished. The pill and the
     * slots join want only live ones; the Live table wants both, because a task
     * between turns has no request in flight and would otherwise blink away.
     */
    function progressEntries(snap, provider, includeEnded) {
      const wanted = typeof provider === 'string' && provider !== '' ? provider : null;
      const list = Array.isArray(snap.progressLive) ? snap.progressLive : [];
      return list.filter((e) => e !== null && typeof e === 'object'
        && (wanted === null || e.provider === wanted)
        && (endedProgress(e) ? includeEnded === true : Date.now() - e.updatedAt < LIVE_WINDOW_MS));
    }

    /** Requests still in flight. */
    function freshProgress(snap, provider) {
      return progressEntries(snap, provider, false);
    }

    /** Requests in flight plus the ones the host is still holding after they ended. */
    function recentProgress(snap, provider) {
      return progressEntries(snap, provider, true);
    }

    /**
     * How far a prompt request has got, from its own stream: `doneNew`/`totalNew`
     * count only the tokens that still had to be processed, because a prompt that
     * is mostly cached is not 95% "done" — the work is the remainder. `tps` is the
     * delta rate (change in processed over change in time_ms, which cancels the
     * cache offset) with the request's own `promptTps`, which the host keeps as a
     * cumulative average: new prompt tokens over the server's elapsed prompt time.
     *
     * @returns `{ doneNew, totalNew, tps }`, each null when the entry cannot say.
     */
    function promptProgress(entry) {
      const total = typeof entry?.total === 'number' ? entry.total : null;
      const cache = typeof entry?.cache === 'number' ? entry.cache : 0;
      const processed = typeof entry?.processed === 'number' ? entry.processed : null;
      return {
        doneNew: total === null || processed === null ? null : Math.max(0, Math.min(total, processed - cache)),
        totalNew: total === null ? null : total - cache,
        tps: firstRate(entry?.promptTps),
      };
    }

    /**
     * The pill's label, built from THIS session's SSE stream only: `prompt 28%
     * · ETA 12s` while its prompt processes (prompt_progress chunks), the live
     * per-token decode rate otherwise (timings chunks). No /slots or /metrics
     * reading appears here — those live in the dialog. `null` means the
     * icon-only pill, which keeps the dialog reachable while idle.
     *
     * @returns the label text, or null for the icon-only state.
     */
    function labelFor(snap, sessionId, provider, t) {
      if (sessionId === null || sessionId === undefined) return null;
      // Most-recent first: a session can have several in-flight requests
      // (title generation, compaction); the freshest is the one to show.
      const mine = freshProgress(snap, provider)
        .filter((e) => String(e.sessionId) === String(sessionId))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const prompting = mine.find((e) => e.phase === 'prompt' && typeof e.total === 'number' && e.total > 0);
      if (prompting === undefined) {
        const decoding = mine.find((e) => typeof e.decodeTps === 'number' && e.decodeTps > 0);
        if (decoding === undefined) return null;
        const tps = Math.round(decoding.decodeTps);
        // How much this request has produced, then its CURRENT speed: the count
        // only grows, so it is the anchor a reader uses to see the rate move.
        const count = typeof decoding.decoded === 'number' && decoding.decoded > 0 ? compact(decoding.decoded) : null;
        if (count === null) return t('pill.decodeRate', { tps });
        return t('pill.decode', { count, tps });
      }
      const { doneNew, totalNew, tps } = promptProgress(prompting);
      if (doneNew === null || totalNew === null || totalNew <= 0) return null;
      const parts = [t('pill.prompt', {
        done: compact(prompting.processed) ?? String(prompting.processed ?? 0),
        total: compact(prompting.total) ?? String(prompting.total),
        percent: Math.round((doneNew / totalNew) * 100),
      })];
      // ETA + prompt rate come from the host's DELTA rate (change in processed
      // over change in time_ms between events, EMA-smoothed), not the webui's
      // cumulative `(processed-cache)/time_ms`: a partly-cached prompt starts
      // with a long elapsed time_ms but almost no freshly-processed tokens, so
      // the cumulative rate reads near zero and the ETA balloons to nonsense.
      // Deltas cancel the cache offset, so both appear only once a delta exists.
      if (tps !== null) {
        if (doneNew < totalNew) {
          parts.push(t('pill.eta', { eta: fmtEta((totalNew - doneNew) / tps) }));
        }
        parts.push(t('pill.tps', { tps: Math.round(tps) }));
      }
      return parts.join(' · ');
    }

    /** Dialog notes: what the raw payload does not say in one line. */
    function notesFor(snap, t) {
      const notes = [];
      if (snap.servedModelMatches === false && snap.servedModel) notes.push(t('note.serving', { model: snap.servedModel }));
      return notes;
    }

    /** One field list joined the way the dialog's blocks read. */
    function joined(parts, separator = '  ·  ') {
      return parts.filter((v) => v !== null).join(separator);
    }

    /** `128 tok`, the number of tokens a slot has generated, or null. */
    function tokenCount(value) {
      const shown = compact(value);
      return shown === null ? null : shown + ' tok';
    }

    /**
     * `47 tok/s`, or `0.4 tok/s` when a shared batch limits one slot, or null
     * when no rate is known. Rounding a live rate down to `0 tok/s` reads as a
     * broken reading rather than a slow one, so small values keep a decimal.
     */
    function tokenRate(tps) {
      if (typeof tps !== 'number' || !(tps > 0)) return null;
      return (tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10) + ' tok/s';
    }

    /** The first positive rate: the stream's own timing first, the poll delta second. */
    function firstRate(...values) {
      for (const value of values) {
        if (typeof value === 'number' && value > 0) return value;
      }
      return null;
    }

    /**
     * The rate one row displays — the decision lives here alone so the table's
     * total is exactly the sum of the numbers a reader can see.
     */
    function rowRate(row) {
      if (row.phase === 'decode') return firstRate(row.entry?.decodeTps, row.decodeTps);
      // A prompt row has a rate only through its own stream: a slot's context
      // length does not grow while its prompt is processed, so there is nothing
      // else to measure, and inventing one showed a rate ~20x too low.
      if (row.phase === 'prompt') return firstRate(row.entry?.promptTps);
      return null;
    }

    /**
     * Attach this app's in-flight requests to the slots serving them.
     *
     * **Why a join at all:** a prompt percentage needs a denominator, and
     * `/slots` has none — `n_prompt_tokens` there is the slot's live context
     * length, not the task's prompt total. Only the request's own SSE stream
     * carries that total (and the rates), so a row must be tied back to its
     * entry to show them.
     *
     * **Why counters, not ids:** llama.cpp's OpenAI-compatible chunks omit
     * `id_slot` (only llama.cpp's own and Anthropic shapes carry it) and the
     * completion id is random, so the join key is what both sides do report: the
     * cached-prefix length, which is fixed for a task's life, plus how far the
     * context has grown. The stream's `processed` and the slot's
     * `n_prompt_tokens` are the same quantity, so a slot is at most one batch
     * iteration ahead of its last event. Pairs are taken closest-first, each row
     * and entry used once, and anything outside a rate-scaled window around
     * {@link SLOT_MATCH_TOLERANCE} stays unmatched rather than borrowing another
     * request's numbers.
     *
     * @param rows - `slots.rows` from the payload.
     * @param entries - fresh `progressLive` entries.
     * @returns the rows, each with an optional `entry`.
     */
    function matchSlots(rows, entries) {
      const pairs = [];
      for (const row of rows) {
        if (row.active !== true || typeof row.cache !== 'number' || typeof row.ctxLen !== 'number') continue;
        for (const entry of entries) {
          if (entry.cache !== row.cache || typeof entry.processed !== 'number') continue;
          // Both sides report the slot's context length; while decoding the slot
          // has appended `decoded` tokens to it since the last prompt event.
          const grown = row.phase === 'decode' && typeof row.decoded === 'number' ? row.decoded : 0;
          const distance = Math.abs(row.ctxLen - entry.processed - grown);
          // The slot keeps working between two stream events, so it can be up to
          // one event interval ahead of the entry's last reading: by prompt
          // progress while it prefills, by generated tokens while it decodes.
          const lead = row.phase === 'decode'
            ? (row.decodeTps ?? entry.decodeTps ?? 0)
            : (typeof entry.promptTps === 'number' ? entry.promptTps : 0);
          const tolerance = Math.max(SLOT_MATCH_TOLERANCE, lead * SLOT_EVENT_SECONDS);
          if (distance <= tolerance) pairs.push({ row, entry, distance });
        }
      }
      pairs.sort((a, b) => a.distance - b.distance);
      const matched = new Map();
      const claimed = new Set();
      for (const pair of pairs) {
        if (matched.has(pair.row) || claimed.has(pair.entry)) continue;
        matched.set(pair.row, pair.entry);
        claimed.add(pair.entry);
      }
      return rows.map((row) => (matched.has(row) ? { ...row, entry: matched.get(row) } : row));
    }

    /**
     * The four cells of one slot row — plus its bar fraction and tooltip — as
     * data; the table renderer only places them.
     *
     * Prompting shows percent, ETA and prompt rate from the matched entry: only
     * its `total` is a denominator, and its `processed` is cache-inclusive, so
     * the entry owns every number in that cell. Decoding shows the server's own
     * generated-token count plus the best rate available. A task that is not
     * this app's has no stream, so it shows its new/cached counts and the
     * poll-delta rate instead of a percentage we would have to invent.
     *
     * @param row - one `matchSlots` result.
     * @param t - the locale function.
     * @returns `{ id, tone, state, context, progress, bar, title }`.
     */
    function slotCells(row, t) {
      const tone = row.phase === 'prompt' || row.phase === 'decode' ? row.phase : 'idle';
      const entry = row.entry;
      const context = row.ctxLen === null
        ? '—'
        : row.nCtx === null ? compact(row.ctxLen) : compact(row.ctxLen) + '/' + compact(row.nCtx);
      let progress = '—';
      let bar = null;
      if (tone === 'prompt') {
        const processed = typeof entry?.processed === 'number' ? entry.processed : null;
        const cache = typeof entry?.cache === 'number' ? entry.cache : typeof row.cache === 'number' ? row.cache : 0;
        const total = typeof entry?.total === 'number' ? entry.total : null;
        const totalNew = total === null ? null : total - cache;
        const doneNew = total === null || processed === null ? null : Math.max(0, Math.min(total, processed - cache));
        const tps = rowRate(row);
        if (totalNew !== null && totalNew > 0 && doneNew !== null) {
          progress = joined([
            Math.round((doneNew / totalNew) * 100) + '%',
            tps !== null && doneNew < totalNew
              ? t('pill.eta', { eta: fmtEta((totalNew - doneNew) / tps) })
              : null,
            tokenRate(tps),
          ]);
          bar = doneNew / totalNew;
        } else {
          progress = joined([
            row.processed === null ? null : '+' + compact(row.processed) + ' new',
            row.cache === null || row.cache === 0 ? null : compact(row.cache) + ' cached',
            tokenRate(tps),
          ]);
        }
      } else if (tone === 'decode') {
        progress = joined([tokenCount(row.decoded), tokenRate(rowRate(row))]);
      }
      return {
        id: row.id === null ? '—' : String(row.id),
        tone,
        state: t('slots.state.' + tone),
        context,
        // An active row always has something to say; never render an empty cell.
        progress: progress === '' ? '—' : progress,
        bar,
        title: joined([
          'slot ' + (row.id === null ? '—' : row.id),
          row.nCtx === null ? null : 'n_ctx ' + row.nCtx,
          row.ctxLen === null ? null : 'ctx ' + row.ctxLen,
          row.decoded === null ? null : 'decoded ' + row.decoded,
          row.speculative ? 'speculative' : null,
        ], ' · '),
      };
    }

    /**
     * When a row's TASK was first seen, which is what orders the table. A request
     * carries it from the host (`taskStartedAt`); falling back to the request's own
     * start keeps an older payload readable.
     */
    function taskTime(entry) {
      return typeof entry?.taskStartedAt === 'number' ? entry.taskStartedAt : (entry?.startedAt ?? 0);
    }

    /**
     * The cells of one Live row — task name, state, progress, bar, tooltip — as
     * data, sorted for reading; the renderer only places them.
     *
     * **What names a task**, in priority order: the sub-agent label the host
     * resolved for that session, an auxiliary call's purpose (`title`,
     * `compaction` — the requests that surprise a reader who is idle), `you` for
     * this session, the session's own title, else a plain `chat`. An unlabelled
     * request stays `chat` rather than showing a hex id: the id is in the tooltip,
     * where a reader who needs it can find it.
     *
     * **Order is by task, never by freshness.** `updatedAt` moves on every token
     * and every batch, so sorting by it made concurrent requests swap places on
     * every poll; sorting by the current request's start time made an agent jump
     * down the list on every turn. Rows are therefore this session's first (the
     * pill mirrors them, so they are what a reader watches), then by when each
     * task was first seen — so a row only moves when a task appears or is
     * forgotten. Exact ties keep the host's insertion order, because
     * `Array.prototype.sort` is stable.
     *
     * **A row outlives its request.** `entries` may include requests the host is
     * holding after they ended (a task between turns); such a row is superseded by
     * the same session's live request, and otherwise reports how its request
     * ended rather than a rate that has stopped being true.
     *
     * @param entries - `recentProgress` entries for one provider (live + held).
     * @param options - `{ sessionId, t }`.
     * @returns `{ key, what, tone, state, progress, bar, title }[]`.
     */
    function liveRows(entries, { sessionId, t }) {
      const mine = (entry) => sessionId !== null && sessionId !== undefined
        && entry.sessionId !== null && entry.sessionId !== undefined
        && String(entry.sessionId) === String(sessionId);
      const list = Array.isArray(entries) ? entries : [];
      // One row per task: a row the host is still holding gives way to the same
      // session's live request, so an agent starting its next turn never shows up
      // twice, and its row never leaves the table in between.
      const liveSessions = new Set();
      for (const entry of list) if (!endedProgress(entry)) liveSessions.add(String(entry.sessionId));
      const ordered = list
        .filter((entry) => !endedProgress(entry) || !liveSessions.has(String(entry.sessionId)))
        .sort((a, b) =>
          (mine(b) ? 1 : 0) - (mine(a) ? 1 : 0)
          // By TASK, not by request: an agent on its fifth turn keeps its place.
          || taskTime(a) - taskTime(b));
      return ordered.map((entry) => {
        const finished = endedProgress(entry);
        const tone = finished
          ? (entry.outcome === 'failed' ? 'failed' : 'idle')
          : entry.phase === 'decode' ? 'decode' : entry.phase === 'prompt' ? 'prompt' : 'idle';
        const label = typeof entry.sessionLabel === 'string' && entry.sessionLabel !== '' ? entry.sessionLabel : null;
        const what = entry.sessionKind === 'subagent' && label !== null ? label
          : entry.purpose === 'session-title' ? t('live.what.sessionTitle')
            : entry.purpose === 'compaction' ? t('live.what.compaction')
              : mine(entry) ? t('live.what.you')
                : label !== null ? label
                  : t('live.what.chat');
        let progress = '';
        let bar = null;
        if (finished) {
          // The row says what the request produced, not a rate that has stopped
          // being true; the tooltip keeps the final readings.
          progress = typeof entry.decoded === 'number' && entry.decoded > 0 ? tokenCount(entry.decoded) : '';
        } else if (tone === 'prompt') {
          const { doneNew, totalNew, tps } = promptProgress(entry);
          if (doneNew !== null && totalNew !== null && totalNew > 0) {
            progress = joined([
              Math.round((doneNew / totalNew) * 100) + '%',
              tps !== null && doneNew < totalNew
                ? t('pill.eta', { eta: fmtEta((totalNew - doneNew) / tps) })
                : null,
              tokenRate(tps),
            ]);
            bar = doneNew / totalNew;
          } else {
            const cache = typeof entry.cache === 'number' ? entry.cache : 0;
            progress = joined([
              typeof entry.processed === 'number' ? '+' + compact(Math.max(0, entry.processed - cache)) + ' new' : null,
              cache === 0 ? null : compact(cache) + ' cached',
              tokenRate(tps),
            ]);
          }
        } else if (tone === 'decode') {
          progress = joined([tokenCount(entry.decoded), tokenRate(entry.decodeTps)]);
        }
        const age = (since) => typeof since === 'number' ? Math.max(0, Math.round((Date.now() - since) / 1000)) + 's ago' : null;
        return {
          key: typeof entry.id === 'string' ? entry.id : String(entry.sessionId ?? '?') + '|' + String(entry.startedAt ?? '?'),
          what,
          tone,
          ended: finished,
          state: finished
            ? t('live.state.' + (entry.outcome === 'failed' ? 'failed' : entry.outcome === 'aborted' ? 'stopped' : 'done'))
            : t('slots.state.' + tone),
          // An in-flight request always has something to say; a finished one that
          // produced nothing says `—` rather than pretending to start.
          progress: progress === '' ? (finished ? '—' : t('live.starting')) : progress,
          bar,
          title: joined([
            what + (entry.sessionKind === 'subagent' && label !== null ? ' (sub-agent)' : ''),
            entry.sessionId === null || entry.sessionId === undefined ? null : 'session ' + String(entry.sessionId),
            entry.provider,
            entry.model,
            entry.purpose === null || entry.purpose === undefined ? null : 'purpose ' + entry.purpose,
            finished
              ? `request ${entry.outcome === 'failed' ? 'failed' : entry.outcome === 'aborted' ? 'was stopped' : 'finished'} ${age(entry.endedAt)}`
              : null,
            typeof entry.total === 'number' ? `prompt ${entry.total} tok (${entry.cache ?? 0} cached)` : null,
            typeof entry.decoded === 'number' ? `generated ${entry.decoded} tok` : null,
            typeof entry.promptTps === 'number' ? `prompt ${Math.round(entry.promptTps)} tok/s` : null,
            typeof entry.decodeTps === 'number' ? `decode ${Math.round(entry.decodeTps)} tok/s` : null,
            age(entry.startedAt) === null ? null : 'started ' + age(entry.startedAt),
            age(entry.updatedAt) === null ? null : 'updated ' + age(entry.updatedAt),
          ], ' · '),
        };
      });
    }

    /** The dialog's blocks, in render order. */
    const SECTIONS = ['live', 'slots', 'metrics'];
    /** Where a reader's hidden sections are remembered between dialogs. */
    const COLLAPSE_KEY = 'dsh-llamacpp-metrics:collapsed';

    /** The browser store, or undefined when a privacy mode refuses it. */
    function storageOf() {
      try {
        return typeof window === 'undefined' ? undefined : window.localStorage;
      } catch {
        return undefined;
      }
    }

    /**
     * Which sections the reader has hidden: a preference, not state, so it
     * survives closing the dialog and reloading the page. Anything unreadable —
     * absent, private mode, hostile getter, junk — means "all open".
     *
     * @param storage - a `Storage`-like object, or undefined.
     * @returns `{ live, slots, metrics }` booleans.
     */
    function readCollapsed(storage) {
      const collapsed = { live: false, slots: false, metrics: false };
      try {
        const raw = storage === undefined || storage === null ? null : storage.getItem(COLLAPSE_KEY);
        const parsed = raw === null ? null : JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object') {
          for (const id of SECTIONS) if (parsed[id] === true) collapsed[id] = true;
        }
      } catch { /* an unreadable preference is just the default */ }
      return collapsed;
    }

    /** Persist the collapse state; a failure only costs the preference. */
    function writeCollapsed(storage, collapsed) {
      try {
        if (storage !== undefined && storage !== null) storage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
      } catch { /* ignore */ }
    }

    /**
     * One collapsible block: its heading toggles the body, and while the body is
     * hidden the heading carries the section's own headline — collapsing a
     * section must not blind the reader to what it said.
     */
    function Section({ id, title, hint, collapsed, onToggle, children }) {
      // Build the heading's children in an array: a React element has no
      // `children` to push into (children live in `props.children`), and an
      // element that only exists as a stub is no element at all.
      const heading = [
        h('span', { className: 'llamacpp-metrics-chevron' }, '▸'),
        h('span', { className: 'llamacpp-metrics-sectionTitle' }, title),
      ];
      if (collapsed && typeof hint === 'string' && hint !== '') {
        heading.push(h('span', { className: 'llamacpp-metrics-sectionHint' }, hint));
      }
      return h('div', { className: 'llamacpp-metrics-sectionBlock' },
        h('button', {
          type: 'button',
          className: 'llamacpp-metrics-sectionHead',
          'aria-expanded': !collapsed,
          onClick: () => onToggle(id),
        }, ...heading),
        ...(collapsed ? [] : [h('div', { className: 'llamacpp-metrics-sectionBody' }, children)]));
    }

    /**
     * The metrics headline as one line, for the collapsed heading: the rate and
     * the cache share, which is what the strip leads with.
     */
    function metricHint(metrics, metricsEnabled, slots, t) {
      if (metricsEnabled === false) return t('metrics.off');
      if (metrics === null || metrics === undefined) return t('metrics.unavailable');
      return metricHeadline(metrics, slots, t).slice(0, 2).map((cell) => cell.value).join(' · ');
    }

    /** `45s`, `1m 05s` — an ETA in minutes and zero-padded seconds. */
    function fmtEta(seconds) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
      const rounded = Math.max(1, Math.ceil(seconds));
      if (rounded < 60) return rounded + 's';
      return Math.floor(rounded / 60) + 'm ' + String(rounded % 60).padStart(2, '0') + 's';
    }

    /** `45s`, `16.0m`, `1h 12m` — a duration in the unit that reads fastest. */
    function fmtDuration(seconds) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
      const rounded = Math.round(seconds);
      // Minutes only when the rounded value really is a minute, so 59.6 s reads
      // `1m` rather than `60s`.
      if (rounded < 60) return rounded + 's';
      if (rounded < 3600) return (Math.round((seconds / 60) * 10) / 10) + 'm';
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.round((seconds - hours * 3600) / 60);
      return minutes === 0 ? hours + 'h' : hours + 'h ' + minutes + 'm';
    }

    /**
     * The three numbers worth reading first, from the server's own counters and
     * gauges: how fast it generates, how much prompt it reused, and how busy it
     * is. Each cell states its basis in the tooltip, because the bases differ —
     * the rate is cumulative (tokens per second of DECODING, not of wall time),
     * the cache share is cumulative too, and load is right now.
     *
     * @param metrics - the payload's derived metrics, or null when `/metrics` is off.
     * @param slots - `slots` from the payload, for the processing capacity.
     * @returns `[{ key, value, caption, title }]`, skipping what the server did not report.
     */
    function metricHeadline(metrics, slots, t) {
      if (metrics === null || metrics === undefined) return [];
      const cells = [];
      const decodeTps = firstRate(metrics.decodeTps);
      const overall = typeof metrics.predictedTotal === 'number' && typeof metrics.decodeSecondsTotal === 'number' && metrics.decodeSecondsTotal > 0
        ? Math.round((metrics.predictedTotal / metrics.decodeSecondsTotal) * 10) / 10
        : null;
      if (decodeTps !== null || overall !== null) {
        cells.push({
          key: 'generating',
          value: tokenRate(overall ?? decodeTps),
          caption: t('metrics.generating'),
          // No denominator exists for a rate, so this cell carries the live
          // reading instead of a meter — the same third line as its neighbours.
          note: decodeTps === null ? null : t('metrics.note', { rate: tokenRate(decodeTps) }),
          title: joined([
            overall === null ? null : `decoded ${fmtValue(metrics.predictedTotal)} tok in ${fmtDuration(metrics.decodeSecondsTotal)} of decoding since start (${tokenRate(overall)})`,
            decodeTps === null ? null : `now ${tokenRate(decodeTps)} (this dialog's window)`,
          ], ' · '),
        });
      }
      if (typeof metrics.cacheHitPercent === 'number') {
        cells.push({
          key: 'cache',
          value: Math.round(metrics.cacheHitPercent) + '%',
          caption: t('metrics.cacheReuse'),
          meter: { fraction: Math.max(0, Math.min(1, metrics.cacheHitPercent / 100)), tone: 'success' },
          title: `prompt tokens reused ${fmtValue(metrics.cachedPromptTotal ?? 0)} of ${fmtValue((metrics.promptTotal ?? 0) + (metrics.cachedPromptTotal ?? 0))} since start`,
        });
      }
      if (typeof metrics.requestsProcessing === 'number') {
        const total = slots !== null && slots !== undefined && typeof slots.total === 'number' ? slots.total : null;
        const deferred = typeof metrics.requestsDeferred === 'number' ? metrics.requestsDeferred : null;
        cells.push({
          key: 'processing',
          value: total === null ? fmtValue(metrics.requestsProcessing) : fmtValue(metrics.requestsProcessing) + ' / ' + fmtValue(total),
          caption: t('metrics.processing'),
          // A queued request is the one load state worth colouring: it means
          // somebody is waiting for a slot, not just that the server is busy.
          meter: total === null || total <= 0 ? null : { fraction: Math.max(0, Math.min(1, metrics.requestsProcessing / total)), tone: deferred !== null && deferred > 0 ? 'warn' : 'success' },
          title: joined([
            `processing ${metrics.requestsProcessing} of ${total ?? '?'} slots`,
            deferred === null ? null : `${deferred} deferred`,
          ], ' · '),
        });
      }
      return cells;
    }

    /**
     * The rest of the server's story as labelled facts: prefill rate, volumes,
     * speculative decoding and batching, plus the largest sequence it has served
     * (context pressure, not a batch size — llama.cpp's `n_tokens_max` is the
     * longest prompt+generation ever seen).
     *
     * Every clause is omitted rather than printed as zero when the server does not
     * report its source, and the exact counters live in the tooltips.
     */
    function metricRows(metrics, t) {
      if (metrics === null || metrics === undefined) return [];
      const exact = (value) => (typeof value === 'number' ? fmtValue(value) : null);
      const rows = [];
      const promptRate = firstRate(metrics.promptTps);
      const prompting = joined([
        tokenRate(promptRate),
        exact(metrics.promptTotal) === null ? null : `${compact(metrics.promptTotal)} tok`,
        fmtDuration(metrics.promptSecondsTotal),
      ]);
      if (prompting !== '') {
        rows.push({
          key: 'prompting',
          label: t('metrics.row.prompting'),
          value: prompting,
          title: `prompt tokens processed ${exact(metrics.promptTotal) ?? '?'} in ${exact(metrics.promptSecondsTotal) ?? '?'} s of prefill since start`,
        });
      }
      const decoded = joined([
        metrics.predictedTotal === null || metrics.predictedTotal === undefined ? null : `${compact(metrics.predictedTotal)} tok`,
        fmtDuration(metrics.decodeSecondsTotal),
      ]);
      if (decoded !== '') {
        rows.push({
          key: 'decoded',
          label: t('metrics.row.decoded'),
          value: decoded,
          title: `generated ${exact(metrics.predictedTotal) ?? '?'} tok in ${exact(metrics.decodeSecondsTotal) ?? '?'} s of decoding since start`,
        });
      }
      const speculative = joined([
        typeof metrics.specAcceptPercent === 'number' ? `${Math.round(metrics.specAcceptPercent)}% accepted` : null,
        typeof metrics.specDraftSteps === 'number' && metrics.specDraftSteps > 0 && typeof metrics.specAcceptedTokens === 'number'
          ? (Math.round((metrics.specAcceptedTokens / metrics.specDraftSteps) * 10) / 10) + ' tok/step'
          : null,
        typeof metrics.specDraftSteps === 'number' ? compact(metrics.specDraftSteps) + ' steps' : null,
      ]);
      if (speculative !== '') {
        rows.push({
          key: 'speculative',
          label: t('metrics.row.speculative'),
          value: speculative,
          title: joined([
            typeof metrics.specAcceptPercent === 'number' ? `${metrics.specAcceptPercent}% of drafted tokens accepted` : null,
            typeof metrics.specDraftSteps === 'number' ? `${exact(metrics.specDraftSteps)} speculative verification steps` : null,
          ], ' · '),
        });
      }
      const batching = joined([
        typeof metrics.nBusySlotsPerDecode === 'number' ? (Math.round(metrics.nBusySlotsPerDecode * 10) / 10) + ' slots/decode' : null,
      ]);
      if (batching !== '') {
        rows.push({
          key: 'batching',
          label: t('metrics.row.batching'),
          value: batching,
          title: joined([
            typeof metrics.nBusySlotsPerDecode === 'number' ? `average busy slots per llama_decode(): ${metrics.nBusySlotsPerDecode}` : null,
            'llama.cpp counts decode steps, so batching yields more tokens than steps per second',
          ], ' · '),
        });
      }
      if (typeof metrics.nTokensMax === 'number') {
        rows.push({
          key: 'context',
          label: t('metrics.row.context'),
          value: 'max seq ' + compact(metrics.nTokensMax),
          title: `largest observed sequence length so far: ${exact(metrics.nTokensMax)} tokens (prompt + generation)`,
        });
      }
      return rows;
    }

    /**
     * The dialog's "All metrics" block: the server's summary rather than a
     * Prometheus dump. The headline strip carries rate/cache/load, the rows carry
     * the rest, and the raw samples stay one disclosure away (open by default only
     * when nothing could be curated, e.g. on a llama.cpp whose metric names we do
     * not know).
     */
    function MetricView({ metrics, metricsEnabled, slots, t }) {
      if (metricsEnabled === false) return h('div', { className: 'llamacpp-metrics-note' }, t('note.metricsOff'));
      if (metrics === null || metrics === undefined) {
        return h('div', { className: 'llamacpp-metrics-note' }, t('note.metricsUnavailable'));
      }
      const headline = metricHeadline(metrics, slots, t);
      const rows = metricRows(metrics, t);
      const raw = Array.isArray(metrics.raw) ? metrics.raw : [];
      const curated = headline.length > 0 || rows.length > 0;
      const count = raw.length;
      const summary = typeof metrics.rawTotal === 'number' && metrics.rawTotal > count
        ? t('metrics.rawSummaryOf', { count, total: metrics.rawTotal })
        : t('metrics.rawSummary', { count });
      const body = [];
      if (curated) {
        const cells = headline.map((cell) => {
          const lines = [
            h('div', { className: 'llamacpp-metrics-statValue' }, cell.value),
            h('div', { className: 'llamacpp-metrics-statCaption' }, cell.caption),
          ];
          // Third line: a meter when a share of a whole exists, else the live
          // reading — never an empty placeholder.
          if (cell.meter !== undefined && cell.meter !== null) {
            lines.push(h('div', { className: 'llamacpp-metrics-meter', 'data-tone': cell.meter.tone },
              h('span', { className: 'llamacpp-metrics-meterFill', style: { width: Math.round(cell.meter.fraction * 100) + '%' } })));
          } else if (cell.note !== undefined && cell.note !== null) {
            lines.push(h('div', { className: 'llamacpp-metrics-statNote' }, cell.note));
          }
          return h('div', { key: cell.key, className: 'llamacpp-metrics-stat', title: cell.title }, ...lines);
        });
        body.push(h('div', { className: 'llamacpp-metrics-stats' }, ...cells));
      }
      for (const row of rows) {
        body.push(h('div', { key: row.key, className: 'llamacpp-metrics-metricRow', title: row.title },
          h('span', { className: 'llamacpp-metrics-metricLabel' }, row.label),
          h('span', { className: 'llamacpp-metrics-metricValue' }, row.value)));
      }
      if (raw.length > 0) {
        body.push(h('details', { className: 'llamacpp-metrics-details', ...(curated ? {} : { open: true }) },
          h('summary', null, h('span', { className: 'llamacpp-metrics-chevron' }, '▸'), summary),
          h('ul', { className: 'llamacpp-metrics-raw' },
            ...raw.map((sample, index) => h(React.Fragment, { key: 'raw' + index },
              h('li', { className: 'llamacpp-metrics-rawName' }, sample.name + (sample.labels ? '{' + sample.labels + '}' : '')),
              h('li', { className: 'llamacpp-metrics-rawValue' }, fmtValue(sample.value)))))));
      }
      return body.length === 0
        ? h('div', { className: 'llamacpp-metrics-note' }, t('dialog.noMetrics'))
        : h('div', { className: 'llamacpp-metrics' }, ...body);
    }

    /**
     * The dialog's "Live progress" table: one row per request this app has in
     * flight, named by the task it belongs to. It mirrors SlotsView below it —
     * same dot, same tones, same bar — because the two answer the same question
     * from either side: which request, and how far along.
     */
    function LiveView({ live, sessionId, t }) {
      if (live.length === 0) return h('div', { className: 'llamacpp-metrics-note' }, t('dialog.noProgress'));
      const rows = liveRows(live, { sessionId, t });
      const inFlight = rows.filter((row) => row.ended !== true);
      const prompting = inFlight.filter((row) => row.tone === 'prompt').length;
      const decoding = inFlight.length - prompting;
      return h('div', { className: 'llamacpp-metrics-live' },
        h('div', { className: 'llamacpp-metrics-slotSummary' },
          h('span', null, joined([
            t('live.inFlight', { count: inFlight.length }),
            prompting === 0 ? null : t('live.promptingCount', { count: prompting }),
            decoding === 0 ? null : t('live.decodingCount', { count: decoding }),
            rows.length === inFlight.length ? null : t('live.doneCount', { count: rows.length - inFlight.length }),
          ]))),
        h('div', { className: 'llamacpp-metrics-liveHeadRow' },
          h('span', null, t('live.col.what')),
          h('span', null, t('slots.col.state')),
          h('span', null, t('slots.col.progress'))),
        ...rows.map((row) => h('div', {
          key: row.key,
          className: 'llamacpp-metrics-liveRow',
          'data-tone': row.tone,
          title: row.title,
        },
          h('span', { className: 'llamacpp-metrics-liveWhat' },
            h('span', { className: 'llamacpp-metrics-dot' }, row.tone === 'idle' ? '○' : '●'), ' ', row.what),
          h('span', null, row.state),
          h('span', { className: 'llamacpp-metrics-slotProgress' },
            row.bar === null ? null : h('span', { className: 'llamacpp-metrics-bar' },
              h('span', { className: 'llamacpp-metrics-barFill', style: { width: Math.round(row.bar * 100) + '%' } })),
            row.progress))));
    }

    /**
     * The dialog's "Server slots" table: the retained-context summary and its
     * summed rate, a fixed header, then one aligned row per slot. An active slot
     * is marked by its phase-coloured dot and the primary label colour; idle rows
     * recede.
     */
    function SlotsView({ slots, entries, t, sessionId }) {
      if (slots === null || slots === undefined) {
        return h('div', { className: 'llamacpp-metrics-note' }, t('dialog.noSlots'));
      }
      const rows = matchSlots(Array.isArray(slots.rows) ? slots.rows : [], Array.isArray(entries) ? entries : []);
      // The summary's context number covers the whole server (every slot's
      // retained KV), which is not the same quantity as the harness's per-session
      // context pill. Name it server KV and add this session's own live slot so
      // the two numbers can be compared without guessing which is which.
      const sessionRow = sessionId === null || sessionId === undefined
        ? undefined
        : rows.find((row) => row.active && row.entry !== undefined && String(row.entry.sessionId) === String(sessionId));
      const sessionPercent = sessionRow !== undefined
        && typeof sessionRow.ctxLen === 'number'
        && typeof sessionRow.nCtx === 'number'
        && sessionRow.nCtx > 0
        ? Math.round((sessionRow.ctxLen / sessionRow.nCtx) * 1000) / 10
        : null;
      const sessionText = sessionRow === undefined
        || typeof sessionRow.ctxLen !== 'number'
        || sessionPercent === null
        ? null
        : t('slots.session', {
          used: compact(sessionRow.ctxLen),
          max: compact(sessionRow.nCtx),
          percent: sessionPercent,
        });
      const decoded = sessionRow?.decoded;
      const breakdown = sessionText === null || typeof decoded !== 'number' || decoded <= 0
        ? null
        : t('slots.sessionBreakdown', {
          prompt: compact(Math.max(0, sessionRow.ctxLen - decoded)),
          decoded: compact(decoded),
        });
      const summary = joined([
        `${slots.total} ${slots.total === 1 ? 'slot' : 'slots'}`,
        `${slots.processing} processing`,
        sessionText,
        breakdown,
        slots.ctxPercent === null || slots.ctxPercent === undefined
          ? null
          : t('slots.serverKv', {
            used: compact(slots.ctxTokens),
            max: compact(slots.ctxMax),
            percent: slots.ctxPercent,
          }),
      ]);
      // The whole server's token rate: every active slot's own displayed rate,
      // summed. A prompt-phase rate counts too, so a prefill visibly dominates.
      const totalTps = rows.reduce((sum, row) => sum + (rowRate(row) ?? 0), 0);
      return h('div', { className: 'llamacpp-metrics-slots' },
        h('div', { className: 'llamacpp-metrics-slotSummary' },
          h('span', { title: t('slots.sessionTitle') }, summary),
          totalTps > 0 ? h('span', { className: 'llamacpp-metrics-slotTotal', title: t('slots.totalTitle') }, tokenRate(totalTps)) : null),
        h('div', { className: 'llamacpp-metrics-slotHeadRow' },
          h('span', null, t('slots.col.slot')),
          h('span', null, t('slots.col.state')),
          h('span', { className: 'llamacpp-metrics-slotCtx' }, t('slots.col.context')),
          h('span', null, t('slots.col.progress'))),
        ...rows.map((row) => {
          const cell = slotCells(row, t);
          return h('div', {
            key: 'slot' + cell.id,
            className: 'llamacpp-metrics-slotRow',
            'data-tone': cell.tone,
            title: cell.title,
          },
            h('span', { className: 'llamacpp-metrics-slotId' },
              h('span', { className: 'llamacpp-metrics-dot' }, cell.tone === 'idle' ? '○' : '●'), cell.id),
            h('span', null, cell.state),
            h('span', { className: 'llamacpp-metrics-slotCtx' }, cell.context),
            h('span', { className: 'llamacpp-metrics-slotProgress' },
              cell.bar === null ? null : h('span', { className: 'llamacpp-metrics-bar' },
                h('span', { className: 'llamacpp-metrics-barFill', style: { width: Math.round(cell.bar * 100) + '%' } })),
              cell.progress));
        }));
    }

    /* ------------------------------------------------------------------ */
    /* The Models-page card: one llama.cpp server as a settings draft.     */
    /*                                                                     */
    /* The page owns the row and the write wire; this plugin owns the form, */
    /* because the generic provider editor only knows the DeepSeek and      */
    /* pi-ai families and renders an "unknown family" hint for ours.        */
    /* ------------------------------------------------------------------ */

    /**
     * What a new server's URL starts as: llama-server's own default port. Upstream
     * moved it from 8080 to 9931 in llama.cpp `b42b7e6d3` ("server: use port 9931 by
     * default", PR #30159), so this is what a stock `llama-server` listens on.
     */
    const SERVER_DEFAULT_URL = 'http://127.0.0.1:9931/v1';
    /** The route id the add-provider list offers first. */
    const SERVER_DEFAULT_ROUTE = 'llamacpp';
    /** Profile fields this card owns. Anything else in the subtree is left alone. */
    const SERVER_FIELDS = ['alias', 'baseURL', 'apiKeyEnv'];

    /** Whether a value is a full http(s) API URL the host would accept. */
    function httpUrl(value) {
      try {
        const url = new URL(String(value).trim());
        return (url.protocol === 'http:' || url.protocol === 'https:')
          && url.search === ''
          && url.hash === ''
          && url.pathname.replace(/\/+$/, '') !== '';
      } catch {
        return false;
      }
    }

    /** The credential reference a route's key is stored under (`<ROUTE>_API_KEY`). */
    function keyRefFor(route) {
      return String(route).toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY';
    }

    /** A user alias that still carries the display wrapper is stored without it. */
    const ALIAS_WRAPPER = /^llama\.cpp\s*\((.*)\)$/i;

    /** The bare alias stored for a route; the `llama.cpp (...)` wrapper is display only. */
    function bareAlias(value) {
      const text = String(value ?? '').trim();
      if (text === '') return '';
      const match = ALIAS_WRAPPER.exec(text);
      return match === null ? text : match[1].trim();
    }

    /**
     * The bare alias a server gets when the user leaves the field blank.
     *
     * Mirrors the host: `host:port`, or the route id when the URL is not parseable
     * yet. Used as the input placeholder, never stored with a prefix.
     *
     * @param baseURL - the draft's endpoint.
     * @param route - the route id.
     * @returns the derived bare alias.
     */
    function defaultAliasFor(baseURL, route) {
      const id = String(route ?? '').trim() || SERVER_DEFAULT_ROUTE;
      try {
        const host = new URL(String(baseURL).trim()).host;
        return host === '' ? id : host;
      } catch {
        return id;
      }
    }

    /** Read a settings subtree by path (absent → undefined). */
    function valueAt(value, path) {
      let current = value;
      for (const key of path) {
        if (typeof current !== 'object' || current === null) return undefined;
        current = current[key];
      }
      return current;
    }

    /** The routes the settings map currently declares, in declaration order. */
    function routesIn(value) {
      const map = valueAt(value, ['servers']);
      return typeof map === 'object' && map !== null ? Object.keys(map) : [];
    }

    /** The first free route id for a new server: `llamacpp`, then `llamacpp-2`… */
    function nextRouteIn(value) {
      const taken = routesIn(value);
      if (!taken.includes(SERVER_DEFAULT_ROUTE)) return SERVER_DEFAULT_ROUTE;
      for (let index = 2; index < 1000; index += 1) {
        const candidate = SERVER_DEFAULT_ROUTE + '-' + index;
        if (!taken.includes(candidate)) return candidate;
      }
      return SERVER_DEFAULT_ROUTE + '-' + Date.now();
    }

    /**
     * One profile subtree as form strings. A blank URL starts at the endpoint the
     * directory entry suggests, which for a new server is the local llama-server
     * default.
     *
     * @param profile - the stored subtree, or null for a new server.
     * @param route - the route id.
     * @param fallbackBaseURL - the directory entry's `defaultBaseURL`.
     * @returns the draft fields.
     */
    function serverDraftOf(profile, route, fallbackBaseURL) {
      const src = profile !== null && typeof profile === 'object' ? profile : {};
      const asText = (value) => (typeof value === 'string' ? value : '');
      const fallback = typeof fallbackBaseURL === 'string' && fallbackBaseURL !== '' ? fallbackBaseURL : SERVER_DEFAULT_URL;
      return {
        route: typeof route === 'string' ? route : '',
        alias: bareAlias(asText(src.alias)),
        baseURL: asText(src.baseURL) === '' ? fallback : asText(src.baseURL),
        apiKeyEnv: asText(src.apiKeyEnv),
      };
    }

    /**
     * What is wrong with a server draft, as copy keys. The card disables Apply on
     * any of these and the write path refuses the same set, so a bad value cannot
     * reach the settings document by a different route.
     */
    function serverUrlProblems(draft) {
      const problems = [];
      const url = String(draft?.baseURL ?? '').trim();
      if (url === '') problems.push('card.urlRequired');
      else if (!httpUrl(url)) problems.push('card.urlInvalid');
      return problems;
    }

    /**
     * The profile a draft describes: only the fields the user filled in, so a new
     * settings document stays readable. `keyTyped` records that a key is
     * about to be stored, which is what puts an `apiKeyEnv` reference in the profile.
     */
    function serverProfileOf(draft, keyRef, keyTyped) {
      const profile = {};
      const text = (value) => String(value ?? '').trim();
      const alias = bareAlias(draft?.alias);
      if (alias !== '') profile.alias = alias;
      if (text(draft?.baseURL) !== '') profile.baseURL = text(draft.baseURL);
      if (text(draft?.apiKeyEnv) !== '') profile.apiKeyEnv = text(draft.apiKeyEnv);
      else if (keyTyped === true) profile.apiKeyEnv = keyRef;
      return profile;
    }

    /**
     * Minimal path ops carrying `after` over `before` for one route's profile.
     *
     * Path-addressed, like the page's own editor: a wholesale `set` rebuilt from a
     * redacted descriptor could delete a field the wire never returned. Only the
     * fields this card owns are named, so anything hand-written beside them stays.
     */
    function serverOpsFor(path, before, after) {
      const previous = before !== null && typeof before === 'object' ? before : {};
      const ops = [];
      for (const key of SERVER_FIELDS) {
        const next = after === null || after === undefined ? undefined : after[key];
        if (next === undefined) {
          if (previous[key] !== undefined) ops.push({ op: 'unset', path: [...path, key] });
          continue;
        }
        if (JSON.stringify(previous[key]) === JSON.stringify(next)) continue;
        ops.push({ op: 'set', path: [...path, key], value: next });
      }
      return ops;
    }

    /** Seat the dialog above its anchor — the dock strip sits at the viewport bottom. */
    function seatAbove(rect, panelWidth) {
      const left = Math.min(Math.max(PANEL_MARGIN, rect.left), Math.max(PANEL_MARGIN, window.innerWidth - panelWidth - PANEL_MARGIN));
      return { left, bottom: window.innerHeight - rect.top + PANEL_GAP };
    }

    /**
     * Poll `/llamacpp-metrics/live` for the selected route.
     *
     * Self-scheduling (`setTimeout` after each reply) rather than `setInterval`,
     * so a slow reply — the host can wait out two upstream timeouts — can never
     * stack a second request on the first, and a wake-up while one is running
     * waits for it instead of racing it. A hidden page stops asking; becoming
     * visible resumes at once. The first poll forces a re-probe; after an
     * offline/unknown answer, polls keep forcing one until the route is healthy,
     * so a server that was down when the dialog opened is noticed when it
     * returns. Healthy polls use the host's cached verdict.
     *
     * `live` asks the host for the dialog's `/metrics` + `/slots` readings, so
     * those are fetched only while the dialog is on screen. Flipping it pokes
     * the loop immediately, so opening the dialog fills at once instead of one
     * interval later.
     *
     * @param provider - the selected provider route, or null before a selection.
     * @param model - the exact model id the route resolved to.
     * @param live - whether the dialog is open and needs server readings.
     * @returns the latest payload, or null while unknown/offline.
     */
    function useLiveSnapshot(provider, model, live) {
      const [snap, setSnap] = React.useState(null);
      const liveRef = React.useRef(live);
      const pokeRef = React.useRef(null);

      React.useEffect(() => {
        liveRef.current = live;
        if (live && pokeRef.current !== null) pokeRef.current();
      }, [live]);

      React.useEffect(() => {
        setSnap(null);
        if (!provider) return undefined;
        let disposed = false;
        let timer = 0;
        let running = false;
        let woke = false;
        let intervalMs = 2500;
        let retryNext = true;
        let activeController = null;
        function schedule(delay = intervalMs) {
          if (disposed) return;
          clearTimeout(timer);
          timer = setTimeout(tick, delay);
        }
        const tick = async () => {
          if (disposed) return;
          if (running) { woke = true; return; }
          if (typeof document !== 'undefined' && document.hidden) return; // resumed on visibilitychange
          running = true;
          const retry = retryNext ? '&retry=1' : '';
          const ask = liveRef.current ? '&live=1' : '';
          // The host endpoint normally answers quickly, but a stalled request
          // must not leave this loop stuck with `running` true forever. Keep
          // the ceiling well above the host's own upstream probe timeouts.
          const controller = new AbortController();
          const timeoutMs = Math.min(Math.max(intervalMs * 4, 10_000), 30_000);
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          activeController = controller;
          try {
            const res = await fetch(
              `/llamacpp-metrics/live?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}${retry}${ask}`,
              { cache: 'no-store', signal: controller.signal },
            );
            if (disposed) return;
            // A non-ok reply (the route is gone during a plugin reload, or the
            // provider is unknown) means this snapshot is no longer current.
            if (!res.ok) {
              setSnap(null);
              retryNext = true;
            } else {
              const json = await res.json();
              if (disposed) return;
              setSnap(json);
              retryNext = json.state !== 'llama' || json.online !== true;
              if (typeof json.pollMs === 'number' && json.pollMs > 0) intervalMs = json.pollMs;
            }
          } catch {
            if (!disposed) setSnap(null);
            retryNext = true;
          } finally {
            clearTimeout(timeout);
            if (activeController === controller) activeController = null;
            running = false;
            if (woke) {
              woke = false;
              schedule(0);
            } else {
              schedule();
            }
          }
        };
        pokeRef.current = () => { if (running) woke = true; else schedule(0); };
        tick();
        const onVisibility = () => {
          if (document.hidden) return;
          clearTimeout(timer);
          void tick();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          disposed = true;
          pokeRef.current = null;
          activeController?.abort();
          clearTimeout(timer);
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [provider, model]);
      return snap;
    }

    /**
     * One server's form: the row's own server (edit) or a new one (create).
     *
     * The profile is only the alias, endpoint, and credential reference. The
     * server is probed once when an existing row opens (and on URL/key blur) only
     * to surface a bad endpoint or credential; its models and context are fetched
     * by the host on demand.
     */
    function ServerForm({ mode, route, defaultBaseURL, loaded, call, t, keyConfigured, onCancel, onSaved }) {
      const creating = mode === 'create';
      const initialRoute = route === null || route === undefined ? SERVER_DEFAULT_ROUTE : route;
      const [draft, setDraft] = React.useState(() => serverDraftOf(null, initialRoute, defaultBaseURL));
      const [dirty, setDirty] = React.useState(false);
      const [keyDraft, setKeyDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      const [probeFailure, setProbeFailure] = React.useState(null);
      const autoProbed = React.useRef(false);
      const probeSeq = React.useRef(0);

      /**
       * Check the endpoint quietly. The model list used by the picker is fetched
       * by the host on demand; this probe exists only to surface a bad endpoint or
       * credential while the form is open. Success adds no visible element.
       */
      const probe = async (baseURL) => {
        const url = String(baseURL ?? '').trim();
        if (!httpUrl(url) || loaded.status !== 'ready') {
          setProbeFailure(null);
          return;
        }
        const seq = ++probeSeq.current;
        try {
          const result = await call.discover(loaded.settingsNs, {
            ...(creating ? {} : { provider: route }),
            baseURL: url,
            ...(keyDraft === '' ? {} : { apiKey: keyDraft }),
          });
          if (seq === probeSeq.current) setProbeFailure(result.kind === 'found' ? null : result.message);
        } catch (error) {
          if (seq === probeSeq.current) setProbeFailure(String(error?.message ?? error));
        }
      };

      // Fill the form from the stored profile, never over what the reader typed.
      // A create form only moves its suggested route when that route got taken.
      // An existing row is checked once as it opens.
      React.useEffect(() => {
        if (loaded.status !== 'ready' || dirty) return;
        if (creating) {
          setDraft((current) => (routesIn(loaded.value).includes(current.route) ? { ...current, route: nextRouteIn(loaded.value) } : current));
          return;
        }
        const next = serverDraftOf(valueAt(loaded.value, ['servers', route]), route, defaultBaseURL);
        setDraft(next);
        if (!autoProbed.current) {
          autoProbed.current = true;
          void probe(next.baseURL);
        }
      }, [loaded, dirty, creating, route]);

      const problems = serverUrlProblems(draft);
      const disabled = busy || loaded.status !== 'ready' || loaded.writable === false;
      const reference = String(draft.apiKeyEnv || keyRefFor(creating ? String(draft.route).trim() || SERVER_DEFAULT_ROUTE : route));
      const aliasPlaceholder = defaultAliasFor(draft.baseURL, creating ? draft.route : route);
      const edit = (key, next) => {
        setDirty(true);
        if (key === 'baseURL') {
          setProbeFailure(null);
          probeSeq.current += 1;
        }
        setDraft((current) => ({ ...current, [key]: next }));
      };
      const field = (label, key, options) => h('label', { className: 'llamacpp-card-field', key: 'f-' + key },
        h('span', { className: 'llamacpp-card-label' }, label),
        h('input', {
          type: options?.type ?? 'text',
          className: 'llamacpp-card-input',
          value: draft[key] ?? '',
          placeholder: options?.placeholder ?? '',
          spellCheck: false,
          autoComplete: 'off',
          disabled,
          'aria-label': label,
          onChange: (event) => edit(key, event.target.value),
          ...(options?.onBlur === undefined ? {} : { onBlur: options.onBlur }),
        }));

      const save = async () => {
        if (disabled || problems.length > 0) return;
        const targetRoute = creating ? String(draft.route).trim() : route;
        const targetPath = ['servers', targetRoute];
        const typed = keyDraft !== '';
        const profile = serverProfileOf(draft, keyRefFor(targetRoute), typed);
        const writes = creating
          ? [{ op: 'set', path: targetPath, value: profile }]
          : serverOpsFor(targetPath, valueAt(loaded.value, targetPath), profile);
        setBusy(true);
        setFailure(null);
        try {
          if (writes.length > 0) {
            const outcome = await call.write(loaded.settingsNs, writes, loaded.revision);
            if (outcome.kind !== 'written') {
              setFailure(outcome.message);
              onSaved(false);
              return;
            }
          }
          if (typed) {
            const refused = await call.setKey(reference, keyDraft);
            if (refused !== null) {
              setFailure(refused);
              onSaved(false);
              return;
            }
            setKeyDraft('');
          }
          setDirty(false);
          autoProbed.current = false;
          onSaved(true);
        } finally {
          setBusy(false);
        }
      };

      const keyPlaceholder = keyConfigured === true ? t('card.keyStored') : '';
      const clearProbe = () => {
        setProbeFailure(null);
        probeSeq.current += 1;
      };
      return h('div', { className: 'llamacpp-card-form' },
        field(t('card.url'), 'baseURL', {
          placeholder: defaultBaseURL ?? SERVER_DEFAULT_URL,
          onBlur: () => { void probe(draft.baseURL); },
        }),
        probeFailure === null ? null : h('p', { className: 'llamacpp-card-hint' }, probeFailure),
        h('details', { className: 'llamacpp-card-advanced' },
          h('summary', { className: 'llamacpp-card-summary' }, t('card.advanced')),
          h('div', { className: 'llamacpp-card-advancedBody' },
            field(t('card.alias'), 'alias', { placeholder: aliasPlaceholder }),
            h('label', { className: 'llamacpp-card-field' },
              h('span', { className: 'llamacpp-card-label' }, t('card.apiKey')),
              h('input', {
                type: 'password',
                className: 'llamacpp-card-input',
                value: keyDraft,
                placeholder: keyPlaceholder,
                autoComplete: 'off',
                disabled,
                'aria-label': t('card.apiKey'),
                onChange: (event) => {
                  clearProbe();
                  setKeyDraft(event.target.value);
                },
                onBlur: () => { void probe(draft.baseURL); },
              })),
            h('p', { className: 'llamacpp-card-hint' }, t(keyConfigured === true ? 'card.keyStoredHint' : 'card.keyHint', { ref: reference })))),
        problems.length > 0 ? h('p', { className: 'llamacpp-card-hint' }, t(problems[0])) : null,
        failure === null ? null : h('p', { className: 'llamacpp-card-error', role: 'alert' }, failure),
        h('div', { className: 'llamacpp-card-actions' },
          typeof onCancel === 'function'
            ? h('button', {
              type: 'button',
              className: 'llamacpp-card-button',
              disabled: busy,
              onClick: onCancel,
            }, t('card.cancel'))
            : null,
          h('button', {
            type: 'button',
            className: 'llamacpp-card-primary',
            disabled: disabled || problems.length > 0,
            onClick: save,
          }, t(busy ? 'card.saving' : creating ? 'card.add' : 'card.apply'))));
    }

    /** How often each configured row checks its server for the header dot. */
    const STATUS_POLL_MS = 15000;

    /**
     * Reachability of one configured server, for the row's header dot.
     *
     * The host's live endpoint re-probes on `retry=1`; the card asks at a
     * low-frequency, visibility-aware cadence. A disabled card (the dormant add
     * draft) never polls.
     */
    function useServerStatus(call, route, enabled) {
      const [status, setStatus] = React.useState('checking');
      React.useEffect(() => {
        if (!enabled || typeof call?.status !== 'function') {
          setStatus('checking');
          return undefined;
        }
        let disposed = false;
        let timer = 0;
        const check = async () => {
          if (typeof document !== 'undefined' && document.hidden) {
            timer = setTimeout(check, STATUS_POLL_MS);
            timer?.unref?.();
            return;
          }
          try {
            const next = await call.status(route);
            if (!disposed) setStatus(next === 'online' ? 'online' : 'offline');
          } catch {
            if (!disposed) setStatus('offline');
          } finally {
            if (!disposed) {
              timer = setTimeout(check, STATUS_POLL_MS);
              timer?.unref?.();
            }
          }
        };
        void check();
        return () => {
          disposed = true;
          clearTimeout(timer);
        };
      }, [call, route, enabled]);
      return status;
    }

    /**
     * The server card the Models page renders inside every row of this plugin's
     * family: the row's own server (edit), or the form that creates one (the
     * directory's dormant add row). Another server is added through the page's own
     * "Add model provider" flow, which is why there is no second form here.
     *
     * It is registered into `settings.models.provider-card` under this plugin's
     * settings namespace, which is what the page dispatches on. It writes through
     * the page's Remote calls (`call`), so a stale draft is refused with the same
     * diagnostic as the page's own editors.
     */
    function LlamaCppServerCard({ provider, configured, keyConfigured, call, t }) {
      const entry = provider !== null && typeof provider === 'object' ? provider : {};
      const route = typeof entry.provider === 'string' && entry.provider !== '' ? entry.provider : SERVER_DEFAULT_ROUTE;
      const settingsNs = typeof entry.settingsNs === 'string' ? entry.settingsNs : '';
      const [loaded, setLoaded] = React.useState({ status: 'loading', settingsNs, value: null, revision: undefined, writable: false, error: null });
      const [asked, setAsked] = React.useState(0);
      const editing = configured === true;
      // The page dispatches this slot on EVERY row card, but renders its own editor
      // only while the row is open — and it hands the slot no `open` prop. So the
      // row's state is read off the page's own editor element inside the row, and
      // observed rather than read on render: a slot occupant is not guaranteed to
      // re-render when its parent does, so a render-time check stayed collapsed after
      // the first close.
      const [open, setOpen] = React.useState(true);
      const mountRef = React.useRef(null);
      React.useLayoutEffect(() => {
        const mount = mountRef.current;
        if (mount === null || mount === undefined || typeof mount.closest !== 'function') return undefined;
        const row = mount.closest('li');
        const host = row ?? mount.closest('[class$="_addPanel"]');
        if (host === null || host === undefined || typeof host.querySelector !== 'function') return undefined;
        let disposed = false;
        let hidden = null;
        // The page's editor root is the one element whose class ends in `_editor`
        // (CSS-module classes are `hash_editor`); our own classes never do. Hide it
        // while our card is the editor: its unknown-family hint and disabled footer
        // are the duplicate UI we replace.
        const sync = () => {
          if (disposed) return;
          const editor = host.querySelector('[class$="_editor"]');
          if (editor !== hidden) {
            if (hidden !== null && typeof hidden.removeAttribute === 'function') hidden.removeAttribute('data-llamacpp-hidden');
            hidden = editor;
            if (editor !== null && typeof editor.setAttribute === 'function') editor.setAttribute('data-llamacpp-hidden', '');
          }
          if (row !== null) setOpen(editor !== null);
        };
        sync();
        if (typeof MutationObserver === 'undefined') return () => {
          disposed = true;
          if (hidden !== null && typeof hidden.removeAttribute === 'function') hidden.removeAttribute('data-llamacpp-hidden');
        };
        const observer = new MutationObserver(sync);
        observer.observe(host, { childList: true });
        return () => {
          disposed = true;
          observer.disconnect();
          if (hidden !== null && typeof hidden.removeAttribute === 'function') hidden.removeAttribute('data-llamacpp-hidden');
        };
      }, []);
      const reload = React.useCallback(() => setAsked((count) => count + 1), []);
      /**
       * The page owns the editor's Cancel/Close transition. Its unknown-family
       * editor is hidden but still mounted, so its Cancel button remains the one
       * supported way to close the add card or the row editor.
       */
      const closePageEditor = React.useCallback(() => {
        const mount = mountRef.current;
        if (mount === null || mount === undefined || typeof mount.closest !== 'function') return;
        const host = (mount.closest('li') ?? mount.closest('[class$="_addPanel"]'));
        if (host === null || host === undefined || typeof host.querySelector !== 'function') return;
        const editor = host.querySelector('[class$="_editor"]');
        if (editor === null || editor === undefined || typeof editor.querySelectorAll !== 'function') return;
        const buttons = [...editor.querySelectorAll('button')];
        const cancel = buttons.find((button) => typeof button.className === 'string' && button.className.includes('_secondaryButton'))
          ?? buttons.find((button) => button.disabled !== true);
        if (cancel !== undefined && typeof cancel.click === 'function') cancel.click();
      }, []);
      const handleSaved = React.useCallback((committed) => {
        reload();
        // The built-in Apply collapses the editor after a successful write; our
        // hidden page Cancel provides the same close transition.
        if (committed === true) closePageEditor();
      }, [reload, closePageEditor]);

      React.useEffect(() => {
        let live = true;
        call.load(settingsNs).then((result) => {
          if (live) setLoaded({ ...result, settingsNs });
        }, (error) => {
          if (live) setLoaded({ status: 'error', settingsNs, value: null, revision: undefined, writable: false, error: String(error?.message ?? error) });
        });
        return () => { live = false; };
      }, [call, settingsNs, asked]);

      const status = useServerStatus(call, route, editing);
      const statusLabel = status === 'online'
        ? t('card.statusOnline')
        : status === 'offline' ? t('card.statusOffline') : t('card.statusChecking');
      // The page's row header is page-owned; a data attribute lets our stylesheet
      // paint the dot beside the identity, like the built-in provider dots.
      React.useLayoutEffect(() => {
        if (!editing) return undefined;
        const mount = mountRef.current;
        const row = mount !== null && mount !== undefined && typeof mount.closest === 'function' ? mount.closest('li') : null;
        if (row === null || row === undefined || row.dataset === undefined || typeof row.setAttribute !== 'function') return undefined;
        row.dataset.llamacppStatus = status;
        row.setAttribute('aria-description', statusLabel);
        return () => {
          delete row.dataset.llamacppStatus;
          if (typeof row.removeAttribute === 'function') row.removeAttribute('aria-description');
        };
      }, [editing, status, statusLabel]);

      if (loaded.status === 'error') {
        return h('div', { className: 'llamacpp-card' },
          h('p', { className: 'llamacpp-card-error', role: 'alert' }, `${t('card.loadFailed')} ${String(loaded.error ?? '')}`));
      }

      // A configured row shows nothing until the page's own Edit opens it; the add
      // flow's card is open by definition, so it shows the create form.
      const body = !editing || open
        ? h('div', { className: editing ? 'llamacpp-card llamacpp-card-editor' : 'llamacpp-card' },
          h(ServerForm, {
            mode: editing ? 'edit' : 'create',
            route,
            defaultBaseURL: typeof entry.defaultBaseURL === 'string' && entry.defaultBaseURL !== '' ? entry.defaultBaseURL : SERVER_DEFAULT_URL,
            loaded,
            call,
            t,
            keyConfigured: editing && keyConfigured === true,
            onCancel: closePageEditor,
            onSaved: handleSaved,
          }))
        : null;
      return h('div', { ref: mountRef, className: 'llamacpp-card-mount' }, body);
    }

    /**
     * The Host calls the server card makes, bound to the client's own Remote
     * namespaces.
     *
     * Same shapes the Models page's editors use (a `settings.mutate` with path ops
     * and the revision the draft was read at), so a concurrent edit is refused here
     * exactly as it is there, and every refusal keeps the Host's own diagnostic.
     */
    function createCardCalls(ctx) {
      const viewOf = (response, settingsNs) => {
        if (!response.ok) return { status: 'error', value: null, revision: undefined, writable: false, error: response.error.message };
        const view = Array.isArray(response.value.namespaces) ? response.value.namespaces.find((row) => row.ns === settingsNs) : undefined;
        if (view === undefined) return { status: 'error', value: null, revision: undefined, writable: false, error: settingsNs };
        return { status: 'ready', value: view.value, revision: view.revision, writable: response.value.writable !== false, error: null };
      };
      return {
        async load(settingsNs) {
          return viewOf(await ctx.remote.settings.describe(), settingsNs);
        },
        async write(settingsNs, ops, revision) {
          const response = await ctx.remote.settings.mutate(settingsNs, ops, revision);
          if (!response.ok) {
            return {
              kind: response.error.code === 'settings/conflict' ? 'conflict' : 'refused',
              message: response.error.message,
            };
          }
          return {
            kind: 'written',
            view: {
              status: 'ready',
              value: response.value.value,
              revision: response.value.revision,
              writable: true,
              error: null,
            },
          };
        },
        async setKey(reference, value) {
          const response = await ctx.remote.credentials.set(reference, value);
          return response.ok ? null : response.error.message;
        },
        async discover(settingsNs, request) {
          const response = await ctx.remote.llm.discoverModels(settingsNs, request);
          if (!response.ok) return { kind: 'refused', message: response.error.message };
          const models = Array.isArray(response.value) ? response.value : [];
          return {
            kind: 'found',
            models,
            contextWindow: models.find((model) => typeof model?.contextWindow === 'number' && model.contextWindow > 0)?.contextWindow ?? null,
          };
        },
        async status(provider) {
          try {
            const response = await fetch(
              `/llamacpp-metrics/live?provider=${encodeURIComponent(provider)}&retry=1`,
              { cache: 'no-store' },
            );
            if (!response.ok) return 'offline';
            const body = await response.json();
            return body !== null && body.online === true && body.state === 'llama' ? 'online' : 'offline';
          } catch {
            return 'offline';
          }
        },
      };
    }

    function LlamaCppPill({ useProjection, t, sessionId }) {
      const selection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined;
      const route = selection ? (selection.next ?? selection.lastUsed) : null;
      const provider = route ? route.provider : null;
      const model = route ? route.model : '';
      const [open, setOpen] = React.useState(false);
      // A reader's hidden sections are a preference: read once, written on every
      // toggle, and never allowed to break the dialog when storage refuses.
      const [collapsed, setCollapsed] = React.useState(() => readCollapsed(storageOf()));
      const toggleSection = (id) => setCollapsed((previous) => {
        const next = { ...previous, [id]: previous[id] !== true };
        writeCollapsed(storageOf(), next);
        return next;
      });
      const snap = useLiveSnapshot(provider, model, open);
      const [pos, setPos] = React.useState(null);
      const rootRef = React.useRef(null);
      const panelRef = React.useRef(null);

      // A new route owns a new snapshot; close rather than show one session's
      // dialog over another session's data.
      React.useEffect(() => {
        setOpen(false);
        setPos(null);
      }, [provider, model]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        const onDown = (e) => {
          const el = e.target;
          if ((rootRef.current !== null && rootRef.current.contains(el)) || (panelRef.current !== null && panelRef.current.contains(el))) return;
          setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onDown, true);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('pointerdown', onDown, true);
        };
      }, [open]);

      // Measure pass, like the built-in pills' anchored dialog: the panel first
      // renders hidden at the origin, then seats ABOVE the pill (the dock strip
      // sits at the bottom of the viewport, so a below-anchor leaves no room).
      // Must stay ABOVE the early returns below — hooks may not be conditional.
      React.useLayoutEffect(() => {
        if (!open || pos !== null) return;
        const panel = panelRef.current;
        const anchor = rootRef.current;
        if (panel === null || anchor === null) return;
        setPos(seatAbove(anchor.getBoundingClientRect(), panel.offsetWidth));
      }, [open, pos]);

      // Re-seat while open: the panel is positioned from a one-shot measure, so
      // a viewport resize (or a composer width change moving the pill) would
      // otherwise leave it detached from its anchor.
      React.useEffect(() => {
        if (!open) return undefined;
        const reseat = () => setPos(null);
        window.addEventListener('resize', reseat);
        return () => window.removeEventListener('resize', reseat);
      }, [open]);

      if (snap === null || snap.state !== 'llama') return null;

      const live = freshProgress(snap, provider);
      // The table also shows requests the host is holding after they ended, so a
      // task between turns keeps its row; the pill and the slots join stay on live
      // requests only.
      const recent = recentProgress(snap, provider);
      const label = labelFor(snap, sessionId, provider, t);
      const notes = notesFor(snap, t);
      // The dialog's raw sections need a payload that actually read the server:
      // while it is closed the host serves the cheap payload, and a server that
      // is down has no readings at all.
      const readings = snap.live !== true ? 'pending' : snap.online === false ? 'offline' : 'ready';

      const openDialog = () => {
        if (!open) setPos(null);
        setOpen(!open);
      };

      return h('span', { ref: rootRef, className: 'llamacpp-metrics-anchor', 'data-composer-stat': 'llama-metrics' },
        h('button', {
          type: 'button',
          className: 'llamacpp-metrics-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': t('pill.aria'),
          title: t('pill.aria'),
          onClick: openDialog,
        }, Icon(), label === null ? null : h('span', { className: 'llamacpp-metrics-label' }, label)),
        open && ReactDOM.createPortal(
          h('div', { ref: panelRef, className: 'llamacpp-metrics-panel', role: 'dialog', 'aria-label': t('dialog.title'), style: pos ?? MEASURE_STYLE },
            h('div', { className: 'llamacpp-metrics-title' },
              h('span', { className: 'llamacpp-metrics-titleIcon' }, Icon(), t('dialog.title'))),
            h('div', { className: 'llamacpp-metrics-rule', 'aria-hidden': true }),
            h(Section, {
              id: 'live',
              title: t('dialog.progress'),
              hint: live.length === 0 ? t('dialog.noProgress') : t('live.inFlight', { count: live.length }),
              collapsed: collapsed.live === true,
              onToggle: toggleSection,
            }, h(LiveView, { live: recent, sessionId, t })),
            h('div', { className: 'llamacpp-metrics-rule', 'aria-hidden': true }),
            h(Section, {
              id: 'slots',
              title: t('dialog.slots'),
              hint: snap.slots === null || snap.slots === undefined ? null : t('slots.hint', { busy: snap.slots.processing, total: snap.slots.total }),
              collapsed: collapsed.slots === true,
              onToggle: toggleSection,
            }, readings === 'ready'
              ? h(SlotsView, { slots: snap.slots, entries: live, t, sessionId })
              : h('div', { className: 'llamacpp-metrics-note' },
                readings === 'offline' ? t('note.offline') : t('dialog.fetching'))),
            readings === 'ready' || snap.metricsEnabled === false
              ? h(Section, {
                id: 'metrics',
                title: t('dialog.metrics'),
                hint: metricHint(snap.metrics, snap.metricsEnabled, snap.slots, t),
                collapsed: collapsed.metrics === true,
                onToggle: toggleSection,
              }, h(MetricView, {
                metrics: readings === 'ready' ? snap.metrics : null,
                metricsEnabled: snap.metricsEnabled,
                slots: readings === 'ready' ? snap.slots : null,
                t,
              }))
              : null,
            notes.map((note, index) => h('div', { key: 'note' + index, className: 'llamacpp-metrics-note' }, note))),
          document.body,
        ));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.locale.register(NS, 'en', dict);
        ctx.effect(() => {
          if (typeof document === 'undefined' || document.querySelector('style[data-plugin-css=' + JSON.stringify(NS) + ']') !== null) {
            return () => {};
          }
          const tag = document.createElement('style');
          tag.dataset.plugin = NS;
          tag.dataset.pluginCss = NS;
          tag.textContent = css;
          document.head.appendChild(tag);
          return () => tag.remove();
        });
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-llm-llamacpp',
          order: 2,
          locale: NS,
        }, LlamaCppPill));
        // The model picker caches its host catalog until it receives an
        // invalidation event. A server restart is not an adapter/settings event,
        // so poll availability from any page; the host detects the transition
        // and publishes `llm/adapters-updated` for the picker.
        ctx.effect(() => {
          if (typeof fetch !== 'function' || typeof document === 'undefined') return () => {};
          let disposed = false;
          let timer = 0;
          let running = false;
          const tick = async () => {
            if (disposed || running) return;
            running = true;
            try {
              if (!document.hidden) {
                const config = await fetch('/llamacpp-metrics/config', { cache: 'no-store' })
                  .then((res) => (res.ok ? res.json() : null))
                  .catch(() => null);
                const routes = Array.isArray(config?.servers) ? config.servers : [];
                await Promise.all(routes.map((provider) => fetch(
                  `/llamacpp-metrics/live?provider=${encodeURIComponent(provider)}&retry=1`,
                  { cache: 'no-store' },
                ).catch(() => {})));
              }
            } finally {
              running = false;
              if (!disposed) {
                timer = setTimeout(tick, STATUS_POLL_MS);
                timer?.unref?.();
              }
            }
          };
          void tick();
          return () => {
            disposed = true;
            clearTimeout(timer);
          };
        });
        // The provider card is the editor for this plugin's rows in Settings →
        // Models. It is keyed by the settings namespace the page dispatches on: the
        // bundle row's id normally, and whatever the host reports when a composition
        // renamed the row. Missing settings Remotes cost only the card, never the
        // pill, which is why this is an optional injection rather than `inject`.
        ctx.inject(['remote', 'remote.settings', 'remote.credentials', 'remote.llm'], (card) => {
          const call = createCardCalls(card);
          const keys = new Set();
          const registerCard = (ns) => {
            if (typeof ns !== 'string' || ns === '' || keys.has(ns)) return;
            keys.add(ns);
            ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
              name: 'settings.models.provider-card',
              key: ns,
              locale: NS,
              inject: () => ({ call }),
            }, LlamaCppServerCard));
          };
          registerCard(NS);
          ctx.effect(() => {
            if (typeof fetch !== 'function') return () => {};
            const controller = new AbortController();
            fetch('/llamacpp-metrics/config', { cache: 'no-store', signal: controller.signal })
              .then((res) => (res.ok ? res.json() : null))
              .then((body) => { if (body !== null && typeof body === 'object') registerCard(body.settingsNs); })
              .catch(() => {});
            return () => controller.abort();
          });
        });
      },
    };
  },
});
