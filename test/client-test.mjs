// Regression suite for the client half: the label chain, the dialog notes and
// the payload the dialog shows. Everything it exercises is lifted out of the
// real `client.js` — no re-implementations.
//
//   node test/client-test.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCardHarness } from './card-runtime.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'client.js'), 'utf8')

// The dictionary, registered with the locale service at apply time.
const dictStart = src.indexOf('const dict = {')
const dictEnd = src.indexOf(String.fromCharCode(10) + '    };', dictStart)
if (dictStart < 0 || dictEnd < 0) throw new Error('dict not found')
const dict = new Function(src.slice(dictStart, dictEnd) + String.fromCharCode(10) + '};' + String.fromCharCode(10) + 'return dict;')()

// The pure helpers sit between `compact` and the polling hook, so one slice
// evaluates all of them (plus the constants they close over).
const pureStart = src.indexOf('    function Icon() {')
const pureEnd = src.indexOf('    function useLiveSnapshot(')
if (pureStart < 0 || pureEnd < 0) throw new Error('pure helpers not found')
// `h` and `React` are parameters so the pure render helpers (SlotsView, LiveView,
// MetricView) can be called and their trees inspected. The children array is
// frozen and mirrored into `props.children` exactly as React does it, so code
// that pushes into an element's children — a crash in the real dock, where the
// error boundary drops the pill without a word — fails here instead.
const h = (type, props, ...children) => Object.freeze({
  type,
  props: props === null || props === undefined ? { children: children.length === 1 ? children[0] : children } : { ...props, children: children.length === 1 ? children[0] : children },
  children: Object.freeze(children),
})
const React = { Fragment: 'fragment' }
const { Icon, compact, fmtValue, fmtEta, fmtDuration, labelFor, notesFor, freshProgress, recentProgress, matchSlots, slotCells, SlotsView, liveRows, LiveView, metricHeadline, metricRows, metricHint, MetricView, Section, readCollapsed, writeCollapsed, keyRefFor, httpUrl, bareAlias, defaultAliasFor, valueAt, routesIn, nextRouteIn, serverDraftOf, serverUrlProblems, serverProfileOf, serverOpsFor } = new Function(
  'h',
  'React',
  src.slice(pureStart, pureEnd) + String.fromCharCode(10)
  + 'return { Icon, compact, fmtValue, fmtEta, fmtDuration, labelFor, notesFor, freshProgress, recentProgress, matchSlots, slotCells, SlotsView, liveRows, LiveView, metricHeadline, metricRows, metricHint, MetricView, Section, readCollapsed, writeCollapsed, keyRefFor, httpUrl, bareAlias, defaultAliasFor, valueAt, routesIn, nextRouteIn, serverDraftOf, serverUrlProblems, serverProfileOf, serverOpsFor };',
)(h, React)

const t = (key, vars = {}) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ' (expected ' + JSON.stringify(expected) + ')'}`)
}

const at = Date.now()
const entry = (over) => ({
  id: 'req-1', sessionId: 's1', provider: 'devboxllamacpp', model: 'm', phase: 'prompt',
  purpose: null, sessionKind: null, sessionLabel: null, taskStartedAt: at,
  endedAt: null, outcome: null,
  total: null, cache: null, processed: null, timeMs: null, decoded: null,
  promptTps: null, decodeTps: null, startedAt: at, updatedAt: at, ...over,
})
const snap = (progressLive, over = {}) => ({ state: 'llama', metrics: {}, progressLive, ...over })

// --- the icon ------------------------------------------------------------
// Official llama.brand geometry, copied verbatim on the asset's own canvas:
// rescaling and single-colour rendering are what the brand grant allows, and a
// redrawn mark is exactly what it does not.
const icon = Icon()
check('the pill icon is the official mark',
  [icon.type, icon.props.viewBox, icon.props.width, icon.props['aria-hidden'], icon.children.length],
  ['svg', '0 0 600 600', 16, true, 2])
check('both paths are the asset\'s own, in the label colour',
  icon.children.map((path) => [path.props.d, path.props.fill]),
  [
    ['M600 392L504.249 558L504.137 557.929C487.252 584.069 458.193 600 426.864 600H120L240 392H600Z', 'currentColor'],
    ['M240 392H0L199.602 46.0254C216.032 17.5463 246.411 3.25756e-05 279.29 0H466.154L240 392Z', 'currentColor'],
  ])

// --- the pill label ------------------------------------------------------
check('first prompt event: percent only',
  labelFor(snap([entry({ total: 1000, cache: 0, processed: 250 })]), 's1', 'devboxllamacpp', t),
  'prompt 250/1K (25%)')
check('mid-prompt adds ETA and rate',
  labelFor(snap([entry({ total: 1000, cache: 0, processed: 500, promptTps: 100 })]), 's1', 'devboxllamacpp', t),
  'prompt 500/1K (50%) · ETA 5s · 100 tok/s')
check('a long ETA reads in minutes and seconds',
  labelFor(snap([entry({ total: 1000, cache: 0, processed: 500, promptTps: 2 })]), 's1', 'devboxllamacpp', t),
  'prompt 500/1K (50%) · ETA 4m 10s · 2 tok/s')
check('mostly cached: percent excludes cache',
  labelFor(snap([entry({ total: 1000, cache: 900, processed: 950, promptTps: 50 })]), 's1', 'devboxllamacpp', t),
  'prompt 950/1K (50%) · ETA 1s · 50 tok/s')
check('fully cached prompt: no label',
  labelFor(snap([entry({ total: 1000, cache: 1000, processed: 1000 })]), 's1', 'devboxllamacpp', t), null)
check('decode phase shows the count and the current rate',
  labelFor(snap([entry({ phase: 'decode', decoded: 226, decodeTps: 47.6 })]), 's1', 'devboxllamacpp', t),
  'decode · 226 tok · 48 tok/s')
check('a compact count stays compact',
  labelFor(snap([entry({ phase: 'decode', decoded: 1234, decodeTps: 47.6 })]), 's1', 'devboxllamacpp', t),
  'decode · 1.2K tok · 48 tok/s')
check('a single token uses the same abbreviation',
  labelFor(snap([entry({ phase: 'decode', decoded: 1, decodeTps: 3.4 })]), 's1', 'devboxllamacpp', t),
  'decode · 1 tok · 3 tok/s')
check('a decode with no count yet still reports the rate',
  labelFor(snap([entry({ phase: 'decode', decoded: null, decodeTps: 47.6 })]), 's1', 'devboxllamacpp', t),
  'decode · 48 tok/s')
check('foreign session only: no label',
  labelFor(snap([entry({ sessionId: 'other', total: 10, processed: 5 })]), 's1', 'devboxllamacpp', t), null)
check('stale entry: no label',
  labelFor(snap([entry({ updatedAt: at - 20000, total: 10, processed: 5 })]), 's1', 'devboxllamacpp', t), null)
check('idle: no label', labelFor(snap([]), 's1', 'devboxllamacpp', t), null)
check('no session id: no label', labelFor(snap([entry({ total: 10, processed: 5 })]), null, 'devboxllamacpp', t), null)
check('the freshest own request wins',
  labelFor(snap([
    entry({ updatedAt: at - 5000, total: 1000, processed: 100 }),
    entry({ updatedAt: at, total: 2000, processed: 1000 }),
  ]), 's1', 'devboxllamacpp', t),
  'prompt 1K/2K (50%)')

// --- dialog notes --------------------------------------------------------
// The routing-era note ("this session runs on the stock route") is gone with the
// architecture: one declared provider, nothing to redirect.
check('no routing note exists any more', notesFor({ routeNative: false, nativeRoute: 'x' }, t).length, 0)
// The All-metrics section states this in place, so the note list must not repeat it.
check('metrics disabled: no duplicate note', notesFor({ metricsEnabled: false }, t).length, 0)
check('model mismatch: note', notesFor({ servedModelMatches: false, servedModel: 'other' }, t).length, 1)
check('the offline notice is not a note (it is the title value)',
  notesFor({ online: false }, t).length, 0)

// --- the /slots table ----------------------------------------------------
const prompting = { id: 0, active: true, phase: 'prompt', nCtx: 262144, ctxLen: 1300, processed: 750, cache: 500, decoded: 0, speculative: true }
const decoding = { id: 1, active: true, phase: 'decode', nCtx: 262144, ctxLen: 19765, processed: 1876, cache: 19633, decoded: 128, speculative: true }
const idleRow = { id: 2, active: false, phase: 'idle', nCtx: 262144, ctxLen: 19637, processed: 0, cache: 0, decoded: 0, speculative: true }
const unused = { id: 3, active: false, phase: 'idle', nCtx: 262144, ctxLen: null, processed: null, cache: null, decoded: null, speculative: true }
const rows = [prompting, decoding, idleRow, unused]
const promptEntry = { sessionId: 's1', phase: 'prompt', total: 2000, cache: 500, processed: 1250, promptTps: 100, updatedAt: at }
const decodeEntry = { sessionId: 's1', phase: 'decode', cache: 19633, processed: 19637, decodeTps: 47.6, updatedAt: at }

const matched = matchSlots(rows, [promptEntry])
check('only the row the stream describes is matched',
  [matched[0].entry === promptEntry, matched[1].entry, matched[2].entry, matched[3].entry],
  [true, undefined, undefined, undefined])
check('a pair further apart than one batch stays unmatched',
  matchSlots([{ ...prompting, ctxLen: 20000 }], [promptEntry])[0].entry, undefined)
// A fast slot can sit a whole 2048-token batch behind its last event, so the window
// scales with how fast that REQUEST is progressing (the entry's own rate).
const fast = { ...prompting, ctxLen: 3400, processed: 2900, cache: 500 }
const fastEntry = { ...promptEntry, promptTps: 400 }
check('the window scales with the request rate',
  matchSlots([fast], [fastEntry])[0].entry === fastEntry, true)
check('and the same gap stays unmatched without a rate',
  matchSlots([fast], [{ ...fastEntry, promptTps: null }])[0].entry, undefined)
check('a decode row is matched by its context minus generated tokens',
  matchSlots([decoding], [decodeEntry])[0].entry === decodeEntry, true)

// The sub-agent case: several fresh concurrent requests all have cached prefix
// 0, so uniqueness cannot decide — the distance does.
const concurrent = [
  { ...prompting, id: 4, ctxLen: 8600, processed: 8600, cache: 0 },
  { ...prompting, id: 5, ctxLen: 2100, processed: 2100, cache: 0 },
]
const entryA = { sessionId: 'a', phase: 'prompt', total: 9000, cache: 0, processed: 8500, promptTps: 100, updatedAt: at }
const entryB = { sessionId: 'b', phase: 'prompt', total: 4000, cache: 0, processed: 2000, promptTps: 50, updatedAt: at }
const paired = matchSlots(concurrent, [entryB, entryA])
check('concurrent fresh requests pair by context distance',
  [paired[0].entry === entryA, paired[1].entry === entryB], [true, true])

const promptingCell = slotCells(matched[0], t)
check('prompting shows percent, ETA and rate', promptingCell.progress, '50%  ·  ETA 8s  ·  100 tok/s')
check('prompting carries a bar', promptingCell.bar, 0.5)
check('the context reads used over capacity', promptingCell.context, '1.3K/262.1K')
check('the state word is localized', promptingCell.state, 'prompting')
check('the tone drives the accent', promptingCell.tone, 'prompt')
check('the row tooltip carries the raw numbers', promptingCell.title, 'slot 0 · n_ctx 262144 · ctx 1300 · decoded 0 · speculative')

const decodingCell = slotCells(matchSlots([decoding], [decodeEntry])[0], t)
check('decoding shows the generated count and rate', decodingCell.progress, '128 tok  ·  48 tok/s')
check('decoding has no bar', decodingCell.bar, null)

// A shared batch gives one slot well under 1 tok/s; that must not round to 0.
const slow = slotCells({ ...decoding, entry: undefined, decodeTps: 0.4 }, t)
check('a sub-1 tok/s rate keeps its decimal', slow.progress, '128 tok  ·  0.4 tok/s')
const noRate = slotCells({ ...prompting, entry: { ...promptEntry, promptTps: null } }, t)
check('a prompting row without a stream rate reports no rate or ETA', noRate.progress, '50%')

const unowned = slotCells({ ...concurrent[0], entry: undefined }, t)
// A slot's context length does not move while its prompt is processed, so there is
// no honest rate to show for another client's prefill — only its counts.
check('an unowned prompt shows its counts and no rate', unowned.progress, '+8.6K new')
check('an unowned prompt has no bar or percent', unowned.bar, null)
check('a reused prefix is still reported when unowned',
  slotCells({ ...prompting, entry: undefined }, t).progress, '+750 new  ·  500 cached')

const idle2 = slotCells(idleRow, t)
check('an idle row shows no progress', idle2.progress, '—')
check('an idle row still shows retained context', idle2.context, '19.6K/262.1K')
check('an idle row uses the idle tone', [idle2.tone, idle2.state], ['idle', 'idle'])
const unused2 = slotCells(unused, t)
check('a never-used slot reads empty', [unused2.context, unused2.progress, unused2.title], ['—', '—', 'slot 3 · n_ctx 262144 · speculative'])

const table = SlotsView({
  slots: { total: 4, processing: 2, ctxTokens: 40474, ctxMax: 1048576, ctxPercent: 3.9, rows },
  entries: [promptEntry, decodeEntry],
  t,
})
check('the table is one block', table.props.className, 'llamacpp-metrics-slots')
check('the summary leads', table.children[0].children[0].children[0], '4 slots  ·  2 processing  ·  server KV 40.5K/1M (3.9%)')
check('the summary explains server KV vs the session pill', table.children[0].children[0].props.title, dict['slots.sessionTitle'])
const ownTable = SlotsView({
  slots: { total: 2, processing: 2, ctxTokens: 40474, ctxMax: 1048576, ctxPercent: 3.9, rows: [prompting, decoding] },
  entries: [promptEntry, decodeEntry],
  sessionId: 's1',
  t,
})
check('the session context is named separately from server KV',
  ownTable.children[0].children[0].children[0],
  '2 slots  ·  2 processing  ·  session context 1.3K/262.1K (0.5%)  ·  server KV 40.5K/1M (3.9%)')
const decodedTable = SlotsView({
  slots: { total: 1, processing: 1, ctxTokens: 19765, ctxMax: 262144, ctxPercent: 7.5, rows: [decoding] },
  entries: [decodeEntry],
  sessionId: 's1',
  t,
})
check('the session line splits prompt from in-flight decoded tokens',
  decodedTable.children[0].children[0].children[0],
  '1 slot  ·  1 processing  ·  session context 19.8K/262.1K (7.5%)  ·  19.6K prompt + 128 decoded  ·  server KV 19.8K/262.1K (7.5%)')
const foreignTable = SlotsView({
  slots: { total: 1, processing: 1, ctxTokens: 19765, ctxMax: 262144, ctxPercent: 7.5, rows: [decoding] },
  entries: [{ ...decodeEntry, sessionId: 's2' }],
  sessionId: 's1',
  t,
})
check('another session’s slot is not shown as this session’s context',
  foreignTable.children[0].children[0].children[0],
  '1 slot  ·  1 processing  ·  server KV 19.8K/262.1K (7.5%)')
// 100 (prompt entry) + 47.6 (decode entry) from the two active rows.
check('the total sums every active row rate', table.children[0].children[1].children[0], '148 tok/s')
check('the total carries its explanation', table.children[0].children[1].props.title, dict['slots.totalTitle'])
check('an idle table shows no total',
  SlotsView({ slots: { total: 1, processing: 0, ctxTokens: 0, ctxMax: 262144, ctxPercent: 0, rows: [unused] }, entries: [], t })
    .children[0].children[1], null)
// Rows with no stream entry contribute their poll rate to the same total.
const unownedTotal = SlotsView({
  slots: {
    total: 2,
    processing: 2,
    ctxTokens: 0,
    ctxMax: 524288,
    ctxPercent: 0,
    rows: [{ ...prompting }, { ...decoding, decodeTps: 12.6 }],
  },
  entries: [],
  t,
})
check('only rates that exist are part of the total', unownedTotal.children[0].children[1].children[0], '13 tok/s')
check('the header names every column',
  table.children[1].children.map((cell) => cell.children[0]),
  ['#', 'state', 'context', 'progress'])
check('one row per slot', table.children.length, 2 + rows.length)
check('the active row carries its tone', table.children[2].props['data-tone'], 'prompt')
check('an idle row carries the idle tone', table.children[4].props['data-tone'], 'idle')
check('the bar fill is the progress fraction',
  table.children[2].children[3].children[0].children[0].props.style.width, '50%')
check('an idle row renders no bar, just the placeholder', table.children[4].children[3].children, [null, '—'])
check('no task id is rendered anywhere', /task\b/.test(JSON.stringify(table)), false)

// --- the Live progress table ---------------------------------------------
// The block this replaces was a monospace dump: the session id truncated to a
// constant `session-`, the prompt size and cache twice, and the same rate named
// three ways, clipped at the panel edge. Now each request is one aligned row
// whose first column names the task it belongs to.
const foreign = entry({ id: 'req-2', sessionId: 's2', total: 800, cache: 0, processed: 400, promptTps: 80 })

check('the table keeps only this provider\'s requests',
  freshProgress({ progressLive: [entry({}), { ...entry({ id: 'req-3' }), provider: 'other' }] }, 'devboxllamacpp').map((e) => e.id),
  ['req-1'])
// One name, one route: the payload's provider is the configured one, so a plain
// comparison is the whole filter (the two-name normalisation is gone with the
// auto-discovery architecture).
check('the configured provider sees its own requests',
  freshProgress({ progressLive: [entry({})] }, 'devboxllamacpp').map((e) => e.id),
  ['req-1'])
check('and excludes another provider',
  freshProgress({ progressLive: [{ ...entry({ id: 'req-3' }), provider: 'localllamacpp' }] }, 'devboxllamacpp').length, 0)
check('a sidecar-style name no longer matches anything',
  freshProgress({ progressLive: [entry({})] }, 'devboxllamacpp-native').length, 0)
check('without a provider it keeps everything',
  freshProgress({ progressLive: [entry({}), { ...entry({ id: 'req-3' }), provider: 'other' }] }, undefined).length, 2)
check('stale entries leave the table',
  freshProgress({ progressLive: [entry({ updatedAt: at - 20000 })] }, 'devboxllamacpp').length, 0)

// The task column: a sub-agent's creation label, an auxiliary purpose, `you` for
// this session, a session title, else a plain chat — never a hex id.
const whatOf = (over, sessionId = 's1') => liveRows([entry(over)], { sessionId, t })[0].what
check('a sub-agent shows its creation label', whatOf({ sessionKind: 'subagent', sessionLabel: 'Research SSE parser' }), 'Research SSE parser')
check('an auxiliary call names its purpose', whatOf({ purpose: 'session-title' }), 'title')
check('compaction too', whatOf({ purpose: 'compaction' }), 'compaction')
check('this session reads you', whatOf({}), 'you')
check('another session shows its title', whatOf({ sessionId: 's2', sessionKind: 'session', sessionLabel: 'Rework the live table' }, 's1'), 'Rework the live table')
check('an unnamed other session is chat', whatOf({ sessionId: 's2' }, 's1'), 'chat')
check('a sub-agent label beats the purpose', whatOf({ purpose: 'session-title', sessionKind: 'subagent', sessionLabel: 'audit' }), 'audit')
check('without a session id nothing claims to be you', whatOf({}, null), 'chat')

// Cells.
const promptRow = liveRows([entry({ total: 1000, cache: 900, processed: 950, promptTps: 50 })], { sessionId: 's1', t })[0]
check('prompting shows percent, ETA and rate', promptRow.progress, '50%  ·  ETA 1s  ·  50 tok/s')
check('prompting carries a bar', promptRow.bar, 0.5)
check('the state word is localized', promptRow.state, 'prompting')
check('the tone drives the dot', promptRow.tone, 'prompt')
check('the tooltip names the task and keeps the raw readings', promptRow.title,
  'you · session s1 · devboxllamacpp · m · prompt 1000 tok (900 cached) · prompt 50 tok/s · started 0s ago · updated 0s ago')
const decodeRow = liveRows([entry({ phase: 'decode', decoded: 128, decodeTps: 47.6 })], { sessionId: 's1', t })[0]
check('decoding shows the generated count and rate', decodeRow.progress, '128 tok  ·  48 tok/s')
check('decoding has no bar', decodeRow.bar, null)
check('a fresh request says so', liveRows([entry({})], { sessionId: 's1', t })[0].progress, 'starting…')
check('a fully cached prompt shows counts, not a percent',
  liveRows([entry({ total: 1000, cache: 1000, processed: 1000, promptTps: 250 })], { sessionId: 's1', t })[0].progress,
  '+0 new  ·  1K cached  ·  250 tok/s')
check('a sub-agent is named as such in the tooltip',
  liveRows([entry({ sessionKind: 'subagent', sessionLabel: 'audit' })], { sessionId: 's1', t })[0].title.startsWith('audit (sub-agent) · session s1'), true)

// Order: this session first, then the order the TASKS were first seen — not the
// request that happens to be running, which changes every turn.
const ordered = liveRows([
  entry({ id: 'other-late', sessionId: 's2', taskStartedAt: at - 2000 }),
  entry({ id: 'mine-late', taskStartedAt: at - 1000 }),
  entry({ id: 'other-early', sessionId: 's2', taskStartedAt: at - 3000 }),
  entry({ id: 'mine-early', taskStartedAt: at - 5000 }),
], { sessionId: 's1', t })
check('this session first, then task order',
  ordered.map((row) => row.key), ['mine-early', 'mine-late', 'other-early', 'other-late'])
check('tasks first seen in the same millisecond keep the host order',
  liveRows([entry({ id: 'first' }), entry({ id: 'second' }), entry({ id: 'third' })], { sessionId: 's1', t }).map((row) => row.key),
  ['first', 'second', 'third'])
// The regression this guards: a token arriving must not move a row.
const orderWith = (entries) => liveRows(entries, { sessionId: 's1', t }).map((row) => row.key)
check('a token arriving does not reorder the table',
  [orderWith([entry({ id: 'x', taskStartedAt: at - 2000, updatedAt: at - 2000 }), entry({ id: 'y', taskStartedAt: at - 1000, updatedAt: at - 1000 })]),
    orderWith([entry({ id: 'x', taskStartedAt: at - 2000, updatedAt: at }), entry({ id: 'y', taskStartedAt: at - 1000, updatedAt: at - 50 })])],
  [['x', 'y'], ['x', 'y']])
check('a request finishing leaves the rest in place',
  [orderWith([entry({ id: 'a', taskStartedAt: at - 3000 }), entry({ id: 'b', taskStartedAt: at - 2000 }), entry({ id: 'c', taskStartedAt: at - 1000 })]),
    orderWith([entry({ id: 'a', taskStartedAt: at - 3000 }), entry({ id: 'c', taskStartedAt: at - 1000 })])],
  [['a', 'b', 'c'], ['a', 'c']])

// --- a row outlives its request -------------------------------------------
// A sub-agent between turns has no request in flight. The host holds the finished
// one briefly, so the row neither blinks away nor returns as a different row in a
// different place.
const heldRow = entry({ id: 'held-1', sessionId: 's2', phase: 'decode', decoded: 226, decodeTps: 44.3, endedAt: at - 1000, outcome: 'done' })
check('a held request is not a live one',
  [freshProgress(snap([heldRow]), 'devboxllamacpp').length, recentProgress(snap([heldRow]), 'devboxllamacpp').length], [0, 1])
check('a held row says how it ended instead of a rate',
  liveRows([heldRow], { sessionId: 's1', t }).map((row) => [row.state, row.tone, row.ended, row.progress, row.bar]),
  [['done', 'idle', true, '226 tok', null]])
check('a request that failed says so', liveRows([{ ...heldRow, outcome: 'failed' }], { sessionId: 's1', t })[0].state, 'failed')
check('a request that was stopped says so', liveRows([{ ...heldRow, outcome: 'aborted' }], { sessionId: 's1', t })[0].state, 'stopped')
check('a held row that produced nothing shows a dash',
  liveRows([{ ...heldRow, decoded: 0, phase: 'prompt' }], { sessionId: 's1', t })[0].progress, '—')
check('its tooltip says when the request ended',
  /request finished \d+s ago/.test(liveRows([heldRow], { sessionId: 's1', t })[0].title), true)
check('a held row gives way to the same session\'s live request',
  liveRows([{ ...heldRow, sessionId: 's1' }, entry({ id: 'live-1' })], { sessionId: 's1', t }).map((row) => row.key),
  ['live-1'])
check('another session\'s held row stays',
  liveRows([heldRow, entry({ id: 'live-1' })], { sessionId: 's1', t }).map((row) => row.key), ['live-1', 'held-1'])
// The task's own start orders the row, so an agent on a later turn keeps its place.
check('rows are ordered by task, not by the request that is running',
  liveRows([
    entry({ id: 'first-task-turn-5', sessionId: 's2', taskStartedAt: at - 9000, startedAt: at }),
    entry({ id: 'second-task-turn-1', sessionId: 's3', taskStartedAt: at - 5000, startedAt: at - 4000 }),
  ], { sessionId: 's1', t }).map((row) => row.key),
  ['first-task-turn-5', 'second-task-turn-1'])
const mixed = LiveView({ live: [entry({ id: 'live-1' }), heldRow], sessionId: 's1', t })
check('the summary separates what just finished', mixed.children[0].children[0].children[0], '1 in flight  ·  1 prompting  ·  1 done')

// --- the All metrics section ---------------------------------------------
// What the section used to be: 18 rows of `llamacpp:prompt_tokens_cached_total
// = 1842940`. Now the server's story is three headline numbers and five labelled
// facts, with the raw samples one disclosure away.
const metricsFixture = {
  decodeTps: 9.4, promptTps: 321.169, cacheHitPercent: 85.5,
  predictedTotal: 39556, promptTotal: 313402, cachedPromptTotal: 1842940,
  promptSecondsTotal: 958.908, decodeSecondsTotal: 4304.47,
  requestsProcessing: 5, requestsDeferred: 0,
  specAcceptPercent: 62.5, specAcceptedTokens: 25745, specDraftSteps: 13728,
  nBusySlotsPerDecode: 2.81226, nTokensMax: 64187, rawTotal: 18,
  raw: Array.from({ length: 18 }, (_, i) => ({ name: 'llamacpp:series_' + i + '_total', labels: i === 0 ? 'position="0"' : null, value: i })),
}
const slotsTotal = { total: 8 }

check('durations pick a readable unit',
  [fmtDuration(45.4), fmtDuration(59.6), fmtDuration(958.908), fmtDuration(90), fmtDuration(4304.47), fmtDuration(3600), fmtDuration(-1)],
  ['45s', '1m', '16m', '1.5m', '1h 12m', '1h', null])
check('ETA uses minutes and seconds past a minute',
  [fmtEta(45.4), fmtEta(59.1), fmtEta(60), fmtEta(61.2), fmtEta(250), fmtEta(3600), fmtEta(-1)],
  ['46s', '1m 00s', '1m 00s', '1m 02s', '4m 10s', '60m 00s', null])

const headline = metricHeadline(metricsFixture, slotsTotal, t)
check('the headline is rate, cache and load',
  headline.map((cell) => [cell.key, cell.value, cell.caption]),
  [['generating', '9.2 tok/s', 'generating'], ['cache', '86%', 'prompt cache'], ['processing', '5 / 8', 'processing']])
check('the rate states both bases', headline[0].title,
  'decoded 39,556 tok in 1h 12m of decoding since start (9.2 tok/s) · now 9.4 tok/s (this dialog\'s window)')
check('the cache cell spells out the counters', headline[1].title,
  'prompt tokens reused 1,842,940 of 2,156,342 since start')
check('the load cell carries deferred work', headline[2].title, 'processing 5 of 8 slots · 0 deferred')
check('without /slots the load cell still works', metricHeadline(metricsFixture, null, t)[2].value, '5')
check('an unreported source leaves no cell',
  metricHeadline({ decodeTps: null, promptTps: null }, null, t), [])
check('metrics off has no headline', metricHeadline(null, null, t), [])

const metricFacts = metricRows(metricsFixture, t)
check('the rows name every remaining fact',
  metricFacts.map((row) => [row.key, row.value]),
  [
    ['prompting', '321 tok/s  ·  313.4K tok  ·  16m'],
    ['decoded', '39.6K tok  ·  1h 12m'],
    ['speculative', '63% accepted  ·  1.9 tok/step  ·  13.7K steps'],
    ['batching', '2.8 slots/decode'],
    ['context', 'max seq 64.2K'],
  ])
check('the prefill row keeps the exact counters', metricFacts[0].title,
  'prompt tokens processed 313,402 in 958.91 s of prefill since start')
check('the context row says what the number is', metricFacts[4].title,
  'largest observed sequence length so far: 64,187 tokens (prompt + generation)')
check('a server that reports nothing yields no rows', metricRows({}, t), [])
check('a non-speculative build omits the clause',
  metricRows({ predictedTotal: 10, decodeSecondsTotal: 5 }, t).length, 1)

// One framed card, matching the two tables above it; its heading now belongs to
// the dialog's collapsible block, so the view returns the body alone.
const card = MetricView({ metrics: metricsFixture, metricsEnabled: true, slots: slotsTotal, t })
const detailsOf = (view) => view.children.find((child) => child.type === 'details')
check('the view is the framed card itself', card.props.className, 'llamacpp-metrics')
const strip = card.children[0]
check('the strip holds three cells', [strip.props.className, strip.children.length], ['llamacpp-metrics-stats', 3])
check('each cell is value, caption and a third line',
  strip.children.map((cell) => [cell.props.className, cell.children.length]),
  [['llamacpp-metrics-stat', 3], ['llamacpp-metrics-stat', 3], ['llamacpp-metrics-stat', 3]])
// The rate has no denominator, so its third line is the live reading; the other
// two meter their share of a whole.
check('the rate cell carries the live reading where the meters sit',
  [strip.children[0].children[0].children[0], strip.children[0].children[2].children[0]],
  ['9.2 tok/s', 'now 9.4 tok/s'])
check('the cache cell meters its share',
  [strip.children[1].children[2].props['data-tone'], strip.children[1].children[2].children[0].props.style.width],
  ['success', '86%'])
check('the load cell meters against the slot count',
  [strip.children[2].children[2].props['data-tone'], strip.children[2].children[2].children[0].props.style.width],
  ['success', '63%'])
check('a queued request turns the load meter into a warning',
  MetricView({ metrics: { requestsProcessing: 5, requestsDeferred: 1 }, metricsEnabled: true, slots: { total: 5 }, t })
    .children[0].children[0].children[2].props['data-tone'], 'warn')
check('a rate cell without a live reading keeps its two lines',
  MetricView({ metrics: { predictedTotal: 100, decodeSecondsTotal: 10 }, metricsEnabled: true, slots: null, t })
    .children[0].children[0].children.length, 2)
check('the fact rows follow the strip', card.children.slice(1, 6).map((row) => row.props.className),
  ['llamacpp-metrics-metricRow', 'llamacpp-metrics-metricRow', 'llamacpp-metrics-metricRow', 'llamacpp-metrics-metricRow', 'llamacpp-metrics-metricRow'])
const disclosure = card.children[6]
check('the raw samples are a disclosure, shut by default',
  [disclosure.type, disclosure.props.className, 'open' in disclosure.props, disclosure.children[0].children[1]],
  ['details', 'llamacpp-metrics-details', false, 'raw Prometheus samples (18)'])
check('the disclosure shares the section chevron',
  [disclosure.children[0].children[0].props.className, disclosure.children[0].children[0].children[0]],
  ['llamacpp-metrics-chevron', '▸'])
// One fragment per sample, holding the `name{labels}` and its value.
check('the raw list keeps every forwarded sample',
  [disclosure.children[1].children.length, disclosure.children[1].children[0].children.length,
    disclosure.children[1].children[0].children[0].children[0]],
  [18, 2, 'llamacpp:series_0_total{position="0"}'])
check('a capped list says how many were parsed',
  detailsOf(MetricView({ metrics: { rawTotal: 512, raw: [{ name: 'x', labels: null, value: 1 }] }, metricsEnabled: true, slots: null, t }))
    .children[0].children[1], 'raw Prometheus samples (1 of 512)')
check('an unknown build opens the raw list instead of an empty summary',
  detailsOf(MetricView({ metrics: { rawTotal: 2, raw: [{ name: 'x', labels: null, value: 1 }, { name: 'y', labels: null, value: 2 }] }, metricsEnabled: true, slots: null, t }))
    .props.open, true)
check('metrics off states the fix in place',
  MetricView({ metrics: null, metricsEnabled: false, slots: null, t }).children[0],
  'Metrics disabled — start llama-server with --metrics to see throughput.')
check('enabled but empty says so',
  MetricView({ metrics: { raw: [] }, metricsEnabled: true, slots: null, t }).children[0],
  'The server reported no metrics samples.')
check('enabled but unreadable says so',
  MetricView({ metrics: null, metricsEnabled: true, slots: null, t }).children[0],
  'Metrics are enabled, but this reading is unavailable right now.')

// --- collapsible sections -------------------------------------------------
// A reader hides what they do not care about, and the preference outlives both
// the dialog and the page: storage failures may only cost the preference.
const openAll = { live: false, slots: false, metrics: false }
check('with nothing stored every section is open', readCollapsed(undefined), openAll)
check('a junk value opens everything', readCollapsed({ getItem: () => 'not json' }), openAll)
check('an unreadable store opens everything', readCollapsed({ getItem: () => { throw new Error('private mode') } }), openAll)
check('a stored preference survives',
  readCollapsed({ getItem: () => '{"slots":true,"nonsense":true}' }), { live: false, slots: true, metrics: false })
const written = []
writeCollapsed({ setItem: (key, value) => written.push([key, value]) }, { live: true, slots: false, metrics: true })
check('a toggle is persisted under one key', written, [['dsh-llamacpp-metrics:collapsed', '{"live":true,"slots":false,"metrics":true}']])
check('an unwritable store does not throw',
  writeCollapsed({ setItem: () => { throw new Error('quota') } }, openAll), undefined)
writeCollapsed(undefined, openAll)

const toggled = []
const expanded = Section({ id: 'slots', title: 'Server slots', hint: '2/5 busy', collapsed: false, onToggle: (id) => toggled.push(id), children: 'body' })
check('an expanded section shows its body', [expanded.children.length, expanded.children[1].children[0]], [2, 'body'])
check('and hides the hint, which the body already says',
  expanded.children[0].children.map((child) => child.children[0]), ['▸', 'Server slots'])
check('its heading reports the state to assistive technology', expanded.children[0].props['aria-expanded'], true)
expanded.children[0].props.onClick()
check('clicking the heading asks the owner to toggle that section', toggled, ['slots'])
const collapsedSection = Section({ id: 'live', title: 'Live progress', hint: '1 in flight', collapsed: true, onToggle: () => {}, children: 'body' })
check('a collapsed section drops its body', collapsedSection.children.length, 1)
check('and keeps its headline in the heading',
  collapsedSection.children[0].children.map((child) => child.children[0]), ['▸', 'Live progress', '1 in flight'])
check('a collapsed section without a hint just shows its title',
  Section({ id: 'metrics', title: 'All metrics', hint: null, collapsed: true, onToggle: () => {}, children: null })
    .children[0].children.length, 2)
check('the collapsed hint leads with the strip',
  metricHint(metricsFixture, true, slotsTotal, t), '9.2 tok/s · 86%')
check('metrics off says so in the heading', metricHint(null, false, null, t), 'metrics off')
check('an unreadable metrics reading says so in the heading', metricHint(null, true, null, t), 'metrics unavailable')
check('nothing to curate means no hint', metricHint({ raw: [] }, true, null, t), '')

// --- formatters (the real ones, not a local copy) ------------------------
check('compact keeps sub-1K exact', compact(950), '950')
check('compact shortens thousands', compact(19637), '19.6K')
check('compact shortens millions', compact(1234567), '1.2M')
check('compact passes non-numbers through', compact(undefined), null)
check('fmtValue formats integers with separators', fmtValue(19637), '19,637')
check('fmtValue rounds fractions', fmtValue(47.612), '47.61')

// --- source invariants ---------------------------------------------------
// The dock error boundary silently drops an occupant that throws, so a hook
// below the early return is an invisible crash (React error #310).
const guardIdx = src.indexOf("if (snap === null || snap.state !== 'llama') return null;")
const renderIdx = src.indexOf("return h('span', { ref: rootRef")
if (guardIdx < 0 || renderIdx < 0) throw new Error('hook-order slice not found')
check('no hook call between the guard and the render', /React\.use[A-Za-z]/.test(src.slice(guardIdx, renderIdx)), false)
check('note.offline rendered exactly once', (src.match(/t\('note\.offline'\)/g) ?? []).length, 1)
check('the poll loop is self-scheduling', /setTimeout\(tick, delay\)/.test(src), true)
check('both the card and the global watcher probe the live endpoint',
  src.split('`/llamacpp-metrics/live?provider=${encodeURIComponent(provider)}&retry=1`').length - 1, 2)
check('no interval polling is left', /setInterval\(/.test(src), false)
check('the dialog note is localized', t('dialog.fetching') === 'dialog.fetching', false)
// `/metrics` and `/slots` cost the server nothing while the dialog is closed.
check('the hook takes the dialog-visibility flag', /function useLiveSnapshot\(provider, model, live\)/.test(src), true)
check('the component passes dialog visibility in', /useLiveSnapshot\(provider, model, open\)/.test(src), true)
check('readings are requested only when visible', /liveRef\.current \? '&live=1' : ''/.test(src), true)
check('offline polls re-probe until the route is healthy',
  [/let retryNext = true/.test(src), /retryNext = json\.state !== 'llama' \|\| json\.online !== true/.test(src)], [true, true])
check('healthy polls use the cached verdict', /const retry = retryNext \? '&retry=1' : ''/.test(src), true)
check('a stalled live fetch is aborted',
  [/new AbortController\(\)/.test(src), /signal: controller\.signal/.test(src), /activeController\?\.abort\(\)/.test(src)],
  [true, true, true])
check('the dialog waits for a readings payload', /snap\.live !== true/.test(src), true)
check('the raw response dump is gone', /diagnosticFor|dialog\.response/.test(src), false)
check('the clipped live dump is gone', /llamacpp-metrics-pre/.test(src), false)
check('the live table gets live and held entries', /h\(LiveView, \{ live: recent, sessionId, t \}\)/.test(src), true)
check('the pill and the slots join stay on live requests',
  [/const live = freshProgress\(snap, provider\)/.test(src), /const recent = recentProgress\(snap, provider\)/.test(src)], [true, true])
check('the pill and the tables share one progress derivation', (src.match(/promptProgress\(/g) ?? []).length >= 3, true)
check('live entries are filtered by provider', /freshProgress\(snap, provider\)/.test(src), true)
check('every section is a collapsible block of its own',
  (src.match(/h\(Section, \{\n\s+id: '/g) ?? []).length, 3)
check('no view renders its own heading any more', /'llamacpp-metrics-section'/.test(src), false)
check('no element children are mutated anywhere in the plugin',
  /\.children\s*\.\s*(push|pop|shift|unshift|splice|sort|reverse)\(/.test(src), false)
check('the collapse preference is read once and written on toggle',
  [/useState\(\(\) => readCollapsed\(storageOf\(\)\)\)/.test(src), /writeCollapsed\(storageOf\(\), next\)/.test(src)], [true, true])
check('the old raw dump renderer is gone', /function RawMetrics/.test(src), false)
check('the raw samples sit inside a disclosure', /h\('details', \{ className: 'llamacpp-metrics-details'/.test(src), true)
check('the dialog renders the slots view with the live entries', /h\(SlotsView, \{ slots: snap\.slots, entries: live, t, sessionId \}\)/.test(src), true)
check('opening the dialog pokes the loop', /if \(live && pokeRef\.current !== null\) pokeRef\.current\(\)/.test(src), true)

check('the provider card is registered into the Models page slot, keyed by the namespace',
  [/ctx\.slots\.inject\('settings\.models\.provider-card'/.test(src), /key: ns,/.test(src)], [true, true])
check('the client joins the api-remotes assembly (the card\'s only write wire)',
  JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'), true)

// --- the server card's form ----------------------------------------------
// Pure helpers only: the card itself owns hooks, and these are what decide what
// a write contains — the part a mis-draft turns into a broken route.
check('a key reference is derived from the route', keyRefFor('devbox'), 'DEVBOX_API_KEY')
check('and stays a valid reference for an awkward route', keyRefFor('llama.ccp-2'), 'LLAMA_CCP_2_API_KEY')
check('http(s) without a query is the only acceptable endpoint',
  [httpUrl('http://x:8080/v1'), httpUrl('https://x/api'), httpUrl('https://x'), httpUrl('ftp://x'), httpUrl('x'), httpUrl('http://x/v1?a=1')],
  [true, true, false, false, false, false])
check('a blank alias falls back to the endpoint host and port',
  [defaultAliasFor('http://devbox.local:9931/v1', 'devbox'), defaultAliasFor('nonsense', 'office'), defaultAliasFor('', '')],
  ['devbox.local:9931', 'office', 'llamacpp'])
check('an alias that repeats the display wrapper is stored bare',
  [bareAlias(' devbox '), bareAlias('llama.cpp (devbox)'), bareAlias(''), bareAlias(null)],
  ['devbox', 'devbox', '', ''])
check('a blank draft starts at the local server, with a route',
  serverDraftOf(null, 'llamacpp'), {
    route: 'llamacpp', alias: '', baseURL: 'http://127.0.0.1:9931/v1', apiKeyEnv: '',
  })
check('a draft can start at the directory entry\'s endpoint',
  serverDraftOf(null, 'office', 'http://office.local:8080/v1').baseURL, 'http://office.local:8080/v1')
check('a stored profile becomes editable text',
  serverDraftOf({ alias: 'devbox', baseURL: 'http://devbox:9931/v1', apiKeyEnv: 'DEVBOX_API_KEY' }, 'devbox'),
  {
    route: 'devbox', alias: 'devbox', baseURL: 'http://devbox:9931/v1', apiKeyEnv: 'DEVBOX_API_KEY',
  })
check('a draft needs a URL', serverUrlProblems({ baseURL: '' }), ['card.urlRequired'])
check('a draft needs an http URL', serverUrlProblems({ baseURL: 'ftp://x' }), ['card.urlInvalid'])
check('a complete draft has no problems',
  serverUrlProblems({ alias: 'office', baseURL: 'http://x/v1' }), [])
check('a profile carries only what was filled in',
  serverProfileOf({ route: 'office', alias: '  ', baseURL: ' http://x/v1 ' }, 'OFFICE_API_KEY', false),
  { baseURL: 'http://x/v1' })
check('the alias is written when set, without a display wrapper',
  serverProfileOf({ alias: ' llama.cpp (office) ', baseURL: 'http://x/v1' }, 'OFFICE_API_KEY', false),
  { alias: 'office', baseURL: 'http://x/v1' })
check('a typed key records its reference',
  serverProfileOf({ baseURL: 'http://x/v1' }, 'OFFICE_API_KEY', true), { baseURL: 'http://x/v1', apiKeyEnv: 'OFFICE_API_KEY' })
check('an existing reference is preserved',
  serverProfileOf({ baseURL: 'http://x/v1', apiKeyEnv: 'DEVBOX_API_KEY' }, 'OFFICE_API_KEY', true),
  { baseURL: 'http://x/v1', apiKeyEnv: 'DEVBOX_API_KEY' })
check('edits name only the fields that moved',
  serverOpsFor(['servers', 'devbox'], { alias: 'a', baseURL: 'http://x/v1', apiKeyEnv: 'OLD' }, { alias: 'b', baseURL: 'http://x/v1' }),
  [
    { op: 'set', path: ['servers', 'devbox', 'alias'], value: 'b' },
    { op: 'unset', path: ['servers', 'devbox', 'apiKeyEnv'] },
  ])
check('an untouched profile writes nothing',
  serverOpsFor(['servers', 'x'], { baseURL: 'http://x/v1' }, { baseURL: 'http://x/v1' }), [])
check('fields this card does not own are left alone',
  serverOpsFor(['servers', 'x'], { baseURL: 'http://x/v1', legacy: 1 }, { baseURL: 'http://x/v1' }), [])
check('the settings map is read by path',
  [routesIn({ servers: { a: {}, b: {} } }), valueAt({ servers: { a: { alias: 'm' } } }, ['servers', 'a', 'alias'])],
  [['a', 'b'], 'm'])
check('a new route avoids the ones already declared',
  [nextRouteIn(null), nextRouteIn({ servers: { llamacpp: {} } }), nextRouteIn({ servers: { llamacpp: {}, 'llamacpp-2': {} } })],
  ['llamacpp', 'llamacpp-2', 'llamacpp-3'])

// --- the provider card, mounted and driven --------------------------------
// The card is the only part of the client that writes, so it is the part a
// mis-wire can silently break. Another server is the Models page's own
// "Add model provider" flow (the directory always publishes one free add row),
// so the card is exactly one form: edit for a configured row, create for the
// dormant add row.
{
  const harness = createCardHarness(src)
  const make = (loaded, over = {}) => {
    const writes = []
    const keys = []
    const discoveries = []
    const call = {
      load: async () => loaded,
      write: async (ns, ops, revision) => { writes.push({ ns, ops, revision }); return { kind: 'written', view: loaded } },
      setKey: async (ref, value) => { keys.push([ref, value]); return null },
      discover: async (ns, request) => {
        discoveries.push({ ns, request })
        return { kind: 'found', models: [{ id: 'm', contextWindow: 262144 }], contextWindow: 262144 }
      },
      status: async () => 'online',
    }
    const props = {
      provider: {
        provider: 'llamacpp', displayName: 'llama.cpp (devbox)', settingsNs: 'dsh-llm-llamacpp',
        settingsPath: ['servers', 'llamacpp'], declared: true, defaultBaseURL: 'http://devbox.local:9931/v1',
      },
      configured: true,
      keyConfigured: false,
      call,
      t: harness.t,
      ...over,
    }
    return { props, writes, keys, discoveries, call }
  }
  /** Whether an input with this label lives inside the Advanced disclosure. */
  const insideAdvanced = (tree, label) => {
    let found = null
    const visit = (node, inside) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) { for (const child of node) visit(child, inside); return }
      const next = inside || node.type === 'details'
      if (node.type === 'input' && node.props?.['aria-label'] === label) found = next
      for (const child of node.children ?? []) visit(child, next)
    }
    visit(tree, false)
    return found
  }
  const stored = {
    status: 'ready',
    settingsNs: 'dsh-llm-llamacpp',
    value: { servers: { llamacpp: { alias: 'devbox', baseURL: 'http://devbox.local:9931/v1' } } },
    revision: 7,
    writable: true,
    error: null,
  }

  const scenario = make(stored)
  await harness.mount(scenario.props)
  const texts = harness.texts()
  check('a configured row renders one form with one footer',
    [texts.includes('Server URL'), texts.includes('Customized settings'), texts.includes('Cancel'), texts.includes('Save')],
    [true, true, true, true])
  check('the fetch button, model status and patch-file footer are gone',
    [texts.includes('Fetch models'), texts.some((text) => text.startsWith('Serves')), texts.some((text) => text.includes('cordis.patch.yml'))],
    [false, false, false])
  check('the server URL is the only field outside Advanced',
    [insideAdvanced(harness.tree(), 'Server URL'), insideAdvanced(harness.tree(), 'Alias'), insideAdvanced(harness.tree(), 'API key')],
    [false, true, true])
  check('the page-owned editor is hidden while the card is mounted', harness.editorHidden(), true)
  check('the row gets a reachable status dot', [harness.rowStatus(), harness.rowDescription()], ['online', 'Server reachable'])
  check('opening a configured row probes the server once',
    [scenario.discoveries.length, scenario.discoveries[0].request.provider, scenario.discoveries[0].request.baseURL],
    [1, 'llamacpp', 'http://devbox.local:9931/v1'])
  const offline = make(stored)
  offline.call.status = async () => 'offline'
  harness.reset()
  await harness.mount(offline.props)
  check('an unreachable server paints the row dot red', [harness.rowStatus(), harness.rowDescription()],
    ['offline', 'Server unreachable or credential rejected'])
  check('a successful probe adds no visible status',
    texts.some((text) => text.includes('262.1K')), false)

  // With the page's editor closed (the real default) the card renders nothing at
  // all: the row's own Edit is the only affordance.
  const closed = make(stored)
  harness.reset()
  await harness.mount(closed.props, { rowOpen: false })
  check('a closed row renders nothing', harness.texts(), [])

  // Editing the stored server: only the alias moved.
  harness.reset()
  await harness.mount(scenario.props)
  await harness.type('Alias', 'devbox-lab')
  await harness.click('Save')
  check('an edit writes only the changed field of the row',
    scenario.writes.at(-1).ops, [{ op: 'set', path: ['servers', 'llamacpp', 'alias'], value: 'devbox-lab' }])
  check('saving an edit collapses the row editor', harness.cancelClicks(), 1)

  // Cancel closes the page's own editor through its hidden button.
  harness.reset()
  await harness.mount(scenario.props)
  await harness.click('Cancel')
  check('Cancel closes the row editor', harness.cancelClicks(), 1)

  // The dormant add row is the create form, at the free id the directory reserved.
  const addRow = make(stored, {
    provider: {
      provider: 'llamacpp-2', displayName: 'llama.cpp (new server)', settingsNs: 'dsh-llm-llamacpp',
      settingsPath: ['servers', 'llamacpp-2'], declared: true, defaultBaseURL: 'http://127.0.0.1:9931/v1',
    },
    configured: false,
  })
  harness.reset()
  await harness.mount(addRow.props)
  check('the dormant add row renders the create form only, with no route field',
    [harness.findInput('Route name') === null, harness.findInput('Server URL')?.props.value, harness.findButton('Add server') !== null],
    [true, 'http://127.0.0.1:9931/v1', true])
  check('opening the add draft does not probe before a URL is touched',
    addRow.discoveries.length, 0)
  await harness.blur('Server URL')
  check('leaving the URL probes the endpoint automatically',
    [addRow.discoveries.length, addRow.discoveries[0].request.baseURL, addRow.discoveries[0].request.provider],
    [1, 'http://127.0.0.1:9931/v1', undefined])
  await harness.type('Alias', 'office')
  await harness.type('Server URL', 'http://office.local:8080/v1')
  await harness.type('API key', 'sk-test')
  await harness.blur('API key')
  check('leaving the key re-probes with the one-shot key',
    addRow.discoveries.at(-1).request.apiKey, 'sk-test')
  await harness.click('Add server')
  check('adding writes one minimal servers.<route> subtree in the plugin namespace',
    [addRow.writes.at(-1).ns, addRow.writes.at(-1).ops],
    ['dsh-llm-llamacpp', [{ op: 'set', path: ['servers', 'llamacpp-2'], value: { alias: 'office', baseURL: 'http://office.local:8080/v1', apiKeyEnv: 'LLAMACPP_2_API_KEY' } }]])
  check('a typed key is stored under the route reference', addRow.keys, [['LLAMACPP_2_API_KEY', 'sk-test']])
  check('a successful add closes the page add card', harness.cancelClicks(), 1)

  // A refused write leaves the add card open and shows the host's reason.
  const refused = make(stored, {
    provider: {
      provider: 'llamacpp-2', displayName: 'llama.cpp (new server)', settingsNs: 'dsh-llm-llamacpp',
      settingsPath: ['servers', 'llamacpp-2'], declared: true, defaultBaseURL: 'http://127.0.0.1:9931/v1',
    },
    configured: false,
  })
  refused.call.write = async () => ({ kind: 'refused', message: 'the document moved' })
  harness.reset()
  await harness.mount(refused.props)
  await harness.click('Add server')
  check('a refused add stays open with the reason',
    [harness.cancelClicks(), harness.texts().includes('the document moved')], [0, true])

  // A brand-new profile: the directory's first add row is `llamacpp`.
  const empty = make({ ...stored, value: { servers: {} } }, {
    provider: {
      provider: 'llamacpp', displayName: 'llama.cpp (new server)', settingsNs: 'dsh-llm-llamacpp',
      settingsPath: ['servers', 'llamacpp'], declared: true, defaultBaseURL: 'http://127.0.0.1:9931/v1',
    },
    configured: false,
  })
  harness.reset()
  await harness.mount(empty.props)
  check('an empty profile offers the first server under llamacpp, with no route field',
    [harness.findInput('Route name') === null, harness.findInput('Server URL')?.props.value],
    [true, 'http://127.0.0.1:9931/v1'])
}

check('the card hides the page-owned unknown-family editor',
  [src.includes('data-llamacpp-hidden'), src.includes('[data-llamacpp-hidden]')], [true, true])
check('the card no longer carries a patch-file footer',
  [src.includes('card.storage'), src.includes('cordis.patch.yml')], [false, false])

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
