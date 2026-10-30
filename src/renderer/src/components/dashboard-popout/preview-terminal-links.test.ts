// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { handleOscLink } from '../terminal-pane/terminal-osc-link-routing'
import { commitPreparedLinkForRoutingTest } from '../terminal-pane/terminal-link-handlers-test-fixtures'
import type { TerminalLinkActionRequest } from '../terminal-pane/terminal-link-action-request'
import { installPreviewTerminalRightClickPaste } from './preview-terminal-right-click-paste'
import { installPreviewTerminalLinks } from './preview-terminal-links'

const harness = vi.hoisted<{
  error: ReturnType<typeof vi.fn>
  web: null | { activate: (event: MouseEvent, uri: string) => void }
}>(() => ({ web: null, error: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: harness.error } }))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(activate: (event: MouseEvent, uri: string) => void) {
      harness.web = { activate }
    }
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./preview-terminal-link-context', () => ({
  previewTerminalLinkContext: () => ({
    worktreeId: '',
    worktreePath: '',
    sourceOwner: { kind: 'local' },
    actionDestinations: { primary: 'system' }
  })
}))
const openUrl = vi.fn(async () => {})
const createBrowserTab = vi.fn()
const disposers: (() => void)[] = []
const url = 'https://github.com/stablyai/orca/pull/34229'
const range = { start: { x: 1, y: 1 }, end: { x: 60, y: 1 } }
const DOWN = '\x1b[<0;1;1M'
const UP = '\x1b[<0;1;1m'

beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  Object.assign(window, { api: { shell: { openUrl } } })
  registerHttpLinkStoreAccessor(() => ({
    settings: { openLinksInApp: true },
    createBrowserTab,
    setActiveWorktree: vi.fn()
  }))
})
afterEach(() => {
  disposers
    .splice(0)
    .toReversed()
    .forEach((dispose) => dispose())
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function install(
  config: {
    actions?: boolean
    background?: boolean
    paste?: boolean
    external?: boolean
    none?: boolean
  } = {}
) {
  const element = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  screen.getBoundingClientRect = () => new DOMRect(0, 0, 800, 240)
  element.append(screen)
  document.body.append(element)
  const emulator = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const request = vi.fn<(request: TerminalLinkActionRequest) => void>()
  const clearSelection = vi.fn()
  const onNavigate = vi.fn()
  const writes = vi.fn<(data: string) => void>()
  const terminal = {
    element,
    buffer: emulator.buffer,
    cols: 80,
    rows: 24,
    _core: { linkifier: { _currentLink: { link: { text: url, range } } } },
    options: {} satisfies Terminal['options'],
    hasSelection: () => false,
    getSelection: () => '',
    clearSelection,
    focus: vi.fn(),
    loadAddon: vi.fn(),
    registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() }))
  }
  const options: Terminal['options'] = terminal.options
  const dispose = installPreviewTerminalLinks(
    { ...terminal, options },
    {
      getSettings: () => ({
        openLinksInAppInBackground: config.background,
        terminalRightClickToPaste: config.paste ?? false,
        terminalLinkClickBehavior: config.none ? 'none' : 'actions'
      }),
      linkRouting:
        config.actions === false
          ? undefined
          : {
              getContext: () => ({
                worktreeId: 'wt',
                worktreePath: '/repo',
                sourceOwner: { kind: 'local' },
                actionDestinations: config.external
                  ? { primary: 'system' }
                  : { primary: 'orca', alternate: 'system' }
              }),
              request,
              onNavigate
            }
    }
  )
  dispose.inputOwner.bindSource({ isCurrent: () => true, user: writes, unclassified: writes })
  element.addEventListener('mousedown', () => dispose.inputOwner.handlePtyInput(DOWN, writes, true))
  element.addEventListener('mouseup', () => dispose.inputOwner.handlePtyInput(UP, writes, true))
  const detected = harness.web
  const click = (
    init: MouseEventInit = {},
    via: 'osc' | 'detected' = 'osc',
    target = url
  ): void => {
    const activate = (event: MouseEvent): void => {
      if (via === 'osc') {
        options.linkHandler?.activate(event, target, range)
      } else {
        detected?.activate(event, target)
      }
    }
    element.addEventListener('mouseup', activate, { once: true })
    element.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, buttons: 1, clientX: 5, clientY: 5, ...init })
    )
    element.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        clientX: 5,
        clientY: 5,
        ...init
      })
    )
  }
  const context = (init: MouseEventInit = {}): MouseEvent => {
    options.linkHandler?.hover?.(new MouseEvent('mousemove'), url, range)
    const facts = {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 2,
      clientX: 5,
      clientY: 5,
      ...init
    }
    const down = new MouseEvent('mousedown', facts)
    element.dispatchEvent(down)
    const menu = new MouseEvent('contextmenu', facts)
    Object.defineProperty(menu, 'timeStamp', { value: down.timeStamp })
    element.dispatchEvent(menu)
    return menu
  }
  disposers.push(() => {
    try {
      dispose()
    } finally {
      emulator.dispose()
      element.remove()
    }
  })
  return {
    element,
    terminal: { ...terminal, options },
    request,
    clearSelection,
    onNavigate,
    writes,
    click,
    context,
    owner: dispose.inputOwner
  }
}

describe('preview terminal production link routes', () => {
  it.each(['osc', 'detected'] as const)(
    'uses the same %s direct/action destinations and consumes both child reports',
    (via) => {
      const f = install()
      f.click({ metaKey: true }, via)
      f.click({ metaKey: true, shiftKey: true }, via)
      f.click({}, via)
      expect(createBrowserTab).toHaveBeenCalledWith('wt', url, { activate: true })
      expect(openUrl).toHaveBeenCalledWith(url)
      expect(f.request).toHaveBeenCalledOnce()
      expect(f.request.mock.calls[0]?.[0]).toMatchObject({
        primary: { label: 'Orca Browser' },
        alternate: { label: 'System Browser' }
      })
      expect(f.clearSelection).toHaveBeenCalledTimes(3)
      expect(f.writes).not.toHaveBeenCalled()
    }
  )

  it('preserves foreground handoff and background/external context', () => {
    const f = install()
    f.click({ metaKey: true })
    expect(f.onNavigate).toHaveBeenCalledOnce()
    f.onNavigate.mockClear()
    f.click({ metaKey: true, shiftKey: true })
    expect(f.onNavigate).not.toHaveBeenCalled()
    f.click()
    f.request.mock.calls[0]?.[0].primary.run()
    expect(f.onNavigate).toHaveBeenCalledOnce()
    registerHttpLinkStoreAccessor(() => ({
      settings: { openLinksInAppInBackground: true },
      createBrowserTab,
      setActiveWorktree: vi.fn()
    }))
    const background = install({ background: true })
    background.click()
    background.request.mock.calls[0]?.[0].primary.run()
    expect(background.onNavigate).not.toHaveBeenCalled()
    expect(createBrowserTab).toHaveBeenLastCalledWith('wt', url, { activate: false })
  })

  it('preserves plain SSH direct routing and the old/new failure result', async () => {
    const f = install({ actions: false })
    openUrl.mockRejectedValue(new Error('unavailable'))
    handleOscLink(url, new MouseEvent('click', { metaKey: true }), {
      worktreeId: '',
      worktreePath: '',
      actionDestinations: { primary: 'system' },
      commit: commitPreparedLinkForRoutingTest
    })
    await Promise.resolve()
    f.click({ metaKey: true })
    await Promise.resolve()
    expect(openUrl.mock.calls).toEqual([[url], [url]])
    expect(harness.error.mock.calls[0]).toEqual(harness.error.mock.calls[1])
    f.click()
    expect(f.request).not.toHaveBeenCalled()
    expect(f.writes.mock.calls.map(([text]) => text)).toEqual([DOWN, UP])
    openUrl.mockResolvedValue(undefined)
  })

  it('preserves general paste priority and accepts native Ctrl+Alt/Meta context once after cleanup', () => {
    const f = install({ paste: true })
    const paste = vi.fn()
    disposers.push(
      installPreviewTerminalRightClickPaste({
        container: f.element,
        getTerminal: () => f.terminal,
        isRightClickToPasteEnabled: () => true,
        pasteClipboardText: paste
      })
    )
    f.context()
    expect(paste).toHaveBeenCalledOnce()
    expect(f.request).not.toHaveBeenCalled()
    const menu = f.context({ button: 0, buttons: 1, ctrlKey: true, altKey: true, metaKey: true })
    expect(menu.defaultPrevented).toBe(true)
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.clearSelection.mock.invocationCallOrder[0]).toBeLessThan(
      f.request.mock.invocationCallOrder[0]
    )
    expect(paste).toHaveBeenCalledOnce()
  })

  it.each([{ actions: false }, { none: true }, { middle: true }])(
    'keeps refused preview input with the child: %j',
    async (config) => {
      const f = install(config)
      f.click('middle' in config ? { button: 1, buttons: 0 } : {})
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(f.request).not.toHaveBeenCalled()
      expect(f.writes.mock.calls.map(([text]) => text)).toEqual([DOWN, UP])
    }
  )

  it('keeps pop-out direct destinations external and refuses unsafe OSC targets', () => {
    const f = install({ external: true })
    f.click({ metaKey: true })
    f.click({ metaKey: true }, 'osc', 'javascript:alert(1)')
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(url)
    expect(createBrowserTab).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
  })
})

it.each([10, 100])(
  'retains zero actionless global work and bounded active production callbacks at N=%i',
  (n) => {
    const doc = document.createElement('div').ownerDocument
    const win = doc.defaultView
    if (!win) {
      throw new Error('Missing owner window')
    }
    const records: {
      target: EventTarget
      type: string
      listener: EventListenerOrEventListenerObject
      wrapped: EventListener
    }[] = []
    let callbacks = 0
    let peak = 0
    for (const target of [doc, win]) {
      const add = target.addEventListener
      const remove = target.removeEventListener
      vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
        if (!listener) {
          return
        }
        const wrapped: EventListener = (event) => {
          callbacks++
          if (typeof listener === 'function') {
            listener.call(target, event)
          } else {
            listener.handleEvent(event)
          }
        }
        records.push({ target, type, listener, wrapped })
        peak = Math.max(peak, records.length)
        add.call(target, type, wrapped, options)
      })
      vi.spyOn(target, 'removeEventListener').mockImplementation((type, listener, options) => {
        const index = records.findIndex(
          (r) => r.target === target && r.type === type && r.listener === listener
        )
        const record = records[index]
        if (record) {
          records.splice(index, 1)
          remove.call(target, type, record.wrapped, options)
        } else {
          remove.call(target, type, listener, options)
        }
      })
    }
    const idle = Array.from({ length: n }, () => install({ actions: false }))
    expect(records).toHaveLength(0)
    for (const f of idle) {
      f.click()
    }
    expect(callbacks).toBe(0)
    expect(idle.every((f) => f.writes.mock.calls.length === 2)).toBe(true)
    const active = install()
    expect(active.element.ownerDocument).toBe(doc)
    expect(active.element.ownerDocument.defaultView).toBe(win)
    expect(records).toHaveLength(3)
    active.click()
    expect(active.request).toHaveBeenCalledOnce()
    expect(active.writes).not.toHaveBeenCalled()
    expect(peak).toBeLessThanOrEqual(11)
    expect(callbacks).toBeGreaterThan(0)
    expect(callbacks).toBeLessThanOrEqual(16)
    disposers
      .splice(0)
      .toReversed()
      .forEach((dispose) => dispose())
    expect(records).toHaveLength(0)
    callbacks = 0
    doc.dispatchEvent(new MouseEvent('mousemove'))
    win.dispatchEvent(new Event('blur'))
    expect(callbacks).toBe(0)
  }
)
