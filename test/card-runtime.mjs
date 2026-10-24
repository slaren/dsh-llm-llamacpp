/**
 * A minimal hooks runtime over the REAL provider-card component, so the card's
 * interaction can be driven in a test (and rendered by the mockup harness)
 * without a browser.
 *
 * Why this exists: the first version of the card kept one form and a `creating`
 * flag, and the reload that follows any save reset it — "Add another server"
 * looked dead. A behaviour test needs to actually mount the component, click, type
 * and re-render with a fresh `loaded`, which is what this harness does. It renders
 * the whole tree on every state change (not just the changed component), which is
 * fine because the tree's shape is fixed by the props of one mount.
 *
 * Extracted from `client.js` between markers, like the pure-helper slice the
 * client suite already uses: no re-implementations.
 */

const MARKERS = {
  dict: ['const dict = {', '\n    };'],
  helpers: ['    function Icon() {', '    function useLiveSnapshot('],
  card: ['    function ServerForm(', '    function createCardCalls('],
}

/**
 * @param src - the whole of `client.js`.
 * @returns `{ mount, tree, texts, find, findButton, findInput, findSummary, click, type, dict, t }`.
 */
export function createCardHarness(src) {
  const dict = (() => {
    const start = src.indexOf(MARKERS.dict[0])
    const end = src.indexOf(MARKERS.dict[1], start)
    if (start < 0 || end < 0) throw new Error('dict not found')
    return new Function(`${src.slice(start, end)}\n};\nreturn dict;`)()
  })()
  const t = (key, vars = {}) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))

  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  // The card probes the row for the page's own editor (a class ending in
  // `_editor`) and observes it. The harness provides both: a fake row the test can
  // open or close, and an observer that is inert because the row changes only
  // between mounts.
  const editor = {
    className: 'hash_editor',
    hidden: false,
    setAttribute(name) { if (name === 'data-llamacpp-hidden') editor.hidden = true },
    removeAttribute(name) { if (name === 'data-llamacpp-hidden') editor.hidden = false },
    querySelectorAll(selector) {
      if (selector !== 'button') return []
      return [{
        disabled: false,
        className: 'hash_secondaryButton',
        click() { row.cancelClicks += 1 },
      }]
    },
  }
  const row = {
    open: true,
    cancelClicks: 0,
    dataset: {},
    attributes: {},
    querySelector: (selector) => (selector === '[class$="_editor"]' && row.open ? editor : null),
    setAttribute(name, value) { row.attributes[name] = value },
    removeAttribute(name) { delete row.attributes[name] },
  }
  if (globalThis.MutationObserver === undefined) {
    globalThis.MutationObserver = class {
      constructor(callback) { this.callback = callback }
      observe() {}
      disconnect() {}
    }
  }
  const fakeElement = () => ({
    parentElement: null,
    nextElementSibling: null,
    closest: (selector) => (selector === 'li' ? row : null),
    querySelector: (selector) => row.querySelector(selector),
  })
  const attachRefs = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(attachRefs); return }
    const ref = node.props?.ref
    if (ref !== null && typeof ref === 'object') ref.current = fakeElement()
    attachRefs(node.children)
  }
  const hooks = []
  let cursor = 0
  let pending = []
  let dirty = false

  const React = {
    Fragment: 'fragment',
    useState(init) {
      const index = cursor++
      if (hooks[index] === undefined) {
        hooks[index] = { kind: 'state', value: typeof init === 'function' ? init() : init }
      }
      const slot = hooks[index]
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        dirty = true
      }]
    },
    useLayoutEffect(fn, deps) {
      // Same contract as useEffect for this harness: there is no DOM to measure, so
      // the card's "is the row open?" probe keeps its initial value.
      return this.useEffect(fn, deps)
    },
    useEffect(fn, deps) {
      const index = cursor++
      const previous = hooks[index]
      const changed = previous === undefined || deps === undefined
        || deps.some((dep, at) => !Object.is(dep, previous.deps[at]))
      if (changed) {
        hooks[index] = { kind: 'effect', deps }
        pending.push(fn)
      }
    },
    useRef(init) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { kind: 'ref', value: { current: init } }
      return hooks[index].value
    },
    useCallback(fn) {
      cursor++
      return fn
    },
  }

  const cardStart = src.indexOf(MARKERS.card[0])
  const cardEnd = src.indexOf(MARKERS.card[1], cardStart)
  const helpersStart = src.indexOf(MARKERS.helpers[0])
  const helpersEnd = src.indexOf(MARKERS.helpers[1], helpersStart)
  if (cardStart < 0 || cardEnd < 0 || helpersStart < 0 || helpersEnd < 0) throw new Error('card slice not found')
  const { LlamaCppServerCard } = new Function('h', 'React', `${src.slice(helpersStart, helpersEnd)}\n${src.slice(cardStart, cardEnd)}\nreturn { LlamaCppServerCard };`)(h, React)

  let tree = null
  let currentProps = null

  // React renders a function component by calling it; the stub has to do the same,
  // in the same pass, so every component's hooks consume indices in call order.
  function expand(node) {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(expand)
    const children = node.children.map(expand)
    if (typeof node.type === 'function') {
      const props = { ...node.props, children: children.length === 1 ? children[0] : children }
      return expand(node.type(props))
    }
    return { type: node.type, props: node.props, children }
  }
  async function settle() {
    // The load effect awaits one Remote round trip; three microtask turns cover it.
    for (let turn = 0; turn < 3; turn += 1) await Promise.resolve()
  }

  async function mount(props, options) {
    currentProps = props
    row.open = options !== undefined && options.rowOpen !== undefined ? options.rowOpen : true
    for (let pass = 0; pass < 40; pass += 1) {
      cursor = 0
      pending = []
      dirty = false
      tree = expand(LlamaCppServerCard(props))
      attachRefs(tree)
      for (const effect of pending) effect()
      await settle()
      if (!dirty) return tree
    }
    throw new Error('the card did not settle')
  }

  function walk(node, visit) {
    if (node === null || node === undefined || node === false) return
    if (typeof node === 'string' || typeof node === 'number') return
    if (Array.isArray(node)) return node.forEach((child) => walk(child, visit))
    visit(node)
    walk(node.children, visit)
  }

  const textOf = (node) => (Array.isArray(node.children) ? node.children.map((child) => (typeof child === 'string' ? child : '')).join('') : String(node.children ?? ''))

  return {
    dict,
    t,
    /** Forget every mounted component's state: the next mount is a new card. */
    reset() {
      hooks.length = 0
      tree = null
      currentProps = null
      row.cancelClicks = 0
      row.dataset = {}
      row.attributes = {}
      editor.hidden = false
    },
    mount,
    tree: () => tree,
    texts() {
      const out = []
      walk(tree, (node) => { for (const child of node.children) if (typeof child === 'string') out.push(child) })
      return out
    },
    findAll(predicate) {
      const found = []
      walk(tree, (node) => { if (predicate(node)) found.push(node) })
      return found
    },
    find(predicate) {
      return this.findAll(predicate)[0] ?? null
    },
    // A finder may return more than one node (the card and the page's shell), so
    // every finder takes an occurrence index in document order.
    findButton(label, index = 0) {
      return this.findAll((node) => node.type === 'button' && node.props.onClick !== undefined && textOf(node) === label)[index] ?? null
    },
    findInput(label, index = 0) {
      return this.findAll((node) => node.type === 'input' && node.props['aria-label'] === label)[index] ?? null
    },
    findSummary(label, index = 0) {
      return this.findAll((node) => node.type === 'summary' && textOf(node) === label)[index] ?? null
    },
    async click(label, index = 0) {
      const button = this.findButton(label, index)
      if (button === null) throw new Error(`no button labelled ${label}`)
      button.props.onClick()
      return mount(currentProps)
    },
    async type(label, value, index = 0) {
      const input = this.findInput(label, index)
      if (input === null) throw new Error(`no input labelled ${label}`)
      input.props.onChange({ target: { value } })
      return mount(currentProps)
    },
    async blur(label, index = 0) {
      const input = this.findInput(label, index)
      if (input === null) throw new Error(`no input labelled ${label}`)
      input.props.onBlur?.()
      return mount(currentProps)
    },
    editorHidden: () => editor.hidden,
    cancelClicks: () => row.cancelClicks,
    rowStatus: () => row.dataset.llamacppStatus,
    rowDescription: () => row.attributes['aria-description'],
  }
}
