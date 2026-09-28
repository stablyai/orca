// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { getDefaultSettings } from '../../../../shared/constants'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import { installTerminalPaneLinkHandling, type PaneLinkContext } from './terminal-pane-pane-links'

const { state, writeClipboardText, listeners } = vi.hoisted(() => ({
  state: {
    settings: { terminalClipboardOnSelect: true, terminalCopyTrimsGutter: true },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the behavior only reads these two fields from canonical hook entries.
    agentStatusByPaneKey: {} as Record<
      string,
      { agentType: string; restoredUnconfirmed?: boolean }
    >,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this empty map is populated with typed foreground entries before each test.
    paneForegroundAgentByPaneKey: {} as Record<string, PaneForegroundAgentEntry>
  },
  listeners: new Set<() => void>(),
  writeClipboardText: vi.fn(async (_text: string) => {})
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}))

const PANE_KEY = 'tab:11111111-1111-4111-8111-111111111111'
const cleanup: (() => void)[] = []

beforeEach(() => {
  state.settings.terminalClipboardOnSelect = true
  state.agentStatusByPaneKey = {}
  state.paneForegroundAgentByPaneKey = {
    [PANE_KEY]: { agent: 'codex', shellForeground: false }
  }
  writeClipboardText.mockClear()
  vi.stubGlobal('api', { ui: { writeTerminalClipboardText: writeClipboardText } })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm's DOM renderer only needs text metrics from this canvas.
  const canvas = {
    measureText: () => ({ width: 10, fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 4 })
  } as unknown as CanvasRenderingContext2D
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvas)
})

afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose()
  }
  expect(listeners.size).toBe(0)
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function openPane() {
  const container = document.createElement('div')
  document.body.append(container)
  const terminal = new Terminal({
    cols: 40,
    rows: 4,
    macOptionClickForcesSelection: true,
    allowProposedApi: true
  })
  terminal.open(container)
  const screen = container.querySelector<HTMLElement>('.xterm-screen')!
  screen.style.padding = '0px'
  terminal.element!.style.padding = '0px'
  vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 80))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: link handling only reads the supplied pane members.
  const pane = {
    id: 1,
    terminal,
    container,
    linkTooltip: document.createElement('div')
  } as unknown as ManagedPane
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: link handling only resolves panes through getPanes.
  const manager = { getPanes: () => [pane] } as PaneManager
  const refs: PaneLinkContext['refs'] = {
    linkProviderDisposablesRef: { current: new Map() },
    terminalHandleLinkDisposablesRef: { current: new Map() },
    linkifierClickPrimingDisposablesRef: { current: new Map() },
    linkPointerGesturesRef: { current: new Map() },
    fileLinkClickFallbackDisposablesRef: { current: new Map() },
    httpLinkClickFallbackDisposablesRef: { current: new Map() },
    selectionDisposablesRef: { current: new Map() },
    nativeCopyDisposablesRef: { current: new Map() },
    selectionCaptureTimersRef: { current: new Map() },
    mouseHideDisposablesRef: { current: new Map() }
  }
  const settingsRef = { current: { ...getDefaultSettings('/tmp'), ...state.settings } }
  const context: PaneLinkContext = {
    pane,
    paneKey: PANE_KEY,
    managerRef: { current: manager },
    settingsRef,
    refs,
    linkDeps: {
      worktreeId: 'workspace',
      worktreePath: '/tmp',
      startupCwd: '/tmp',
      managerRef: { current: manager },
      linkProviderDisposablesRef: refs.linkProviderDisposablesRef,
      pathExistsCache: new Map<string, boolean>()
    },
    fileOpenLinkHint: '',
    requestOpenLinksInAppPreference: () => null,
    getHttpLinkSourceOwnerForPane: () => ({ kind: 'local' as const }),
    getHttpLinkActionDestinations: () => ({ primary: 'system' }),
    getLinkActionContext: () => null,
    getPaneLinkCwd: () => '/tmp',
    getUrlOpenLinkHint: () => '',
    onShowSessionRestoredBanner: () => {},
    ptyStartup: null
  }
  installTerminalPaneLinkHandling(context)
  cleanup.push(() => {
    for (const [key, ref] of Object.entries(refs)) {
      if (key === 'selectionCaptureTimersRef') {
        continue
      }
      for (const disposable of ref.current.values()) {
        if (typeof disposable === 'object') {
          disposable.dispose()
        }
      }
    }
    terminal.dispose()
  })
  await new Promise<void>((resolve) =>
    terminal.write('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006hcopy me', resolve)
  )
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  const mouse = (type: string, x: number, altKey = false) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
      clientX: x,
      clientY: 10,
      altKey,
      detail: 1
    })
    // happy-dom omits MouseEvent.getModifierState, which xterm uses for its Alt cursor.
    event.getModifierState = (key: string) => key === 'Alt' && altKey
    return screen.dispatchEvent(event)
  }
  const drag = async (altKey = false) => {
    mouse('mousedown', 1, altKey)
    mouse('mousemove', 70, altKey)
    mouse('mouseup', 70, altKey)
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
  }
  return { terminal, emitted, drag, mouse, settingsRef }
}

describe('Codex Copy on Select', () => {
  it('copies a plain drag through the installed pane handler without sending mouse reports', async () => {
    const pane = await openPane()
    await pane.drag()
    await vi.waitFor(() => expect(writeClipboardText).toHaveBeenLastCalledWith('copy me'))
    expect(pane.emitted).toEqual([])
  })

  it('keeps Option/Alt drags in Codex and leaves the clipboard alone', async () => {
    const pane = await openPane()
    await pane.drag(true)
    expect(pane.emitted.some((data) => data.startsWith('\x1b[<'))).toBe(true)
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('supports a live hook-backed Codex pane without foreground sampling', async () => {
    delete state.paneForegroundAgentByPaneKey[PANE_KEY]
    state.agentStatusByPaneKey[PANE_KEY] = { agentType: 'codex' }
    const pane = await openPane()
    await pane.drag()
    expect(writeClipboardText).toHaveBeenLastCalledWith('copy me')
    expect(pane.emitted).toEqual([])
  })

  it('applies live toggles and releases mouse handling when Codex exits', async () => {
    state.settings.terminalClipboardOnSelect = false
    const pane = await openPane()
    const sync = () => {
      for (const listener of listeners) {
        listener()
      }
    }
    state.settings.terminalClipboardOnSelect = true
    pane.settingsRef.current.terminalClipboardOnSelect = true
    sync()
    await pane.drag()
    expect(writeClipboardText).toHaveBeenLastCalledWith('copy me')

    state.settings.terminalClipboardOnSelect = false
    pane.settingsRef.current.terminalClipboardOnSelect = false
    sync()
    expect(pane.terminal.options.mouseEventsRequireAlt).toBe(false)

    state.settings.terminalClipboardOnSelect = true
    pane.settingsRef.current.terminalClipboardOnSelect = true
    sync()
    state.paneForegroundAgentByPaneKey[PANE_KEY] = { agent: null, shellForeground: true }
    sync()
    writeClipboardText.mockClear()
    pane.emitted.length = 0
    await pane.drag()
    expect(writeClipboardText).not.toHaveBeenCalled()
    expect(pane.emitted.some((data) => data.startsWith('\x1b[<'))).toBe(true)
  })

  it('does not copy a stationary click', async () => {
    const pane = await openPane()
    pane.mouse('mousedown', 1)
    pane.mouse('mouseup', 1)
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it.each([
    'disabled',
    'other-agent',
    'shell',
    'revoked',
    'unknown',
    'restored',
    'sibling'
  ] as const)('leaves app mouse handling alone when %s', async (reason) => {
    if (['other-agent', 'shell', 'revoked'].includes(reason)) {
      state.agentStatusByPaneKey[PANE_KEY] = { agentType: 'codex' }
    }
    if (reason === 'disabled') {
      state.settings.terminalClipboardOnSelect = false
    }
    if (reason === 'other-agent') {
      state.paneForegroundAgentByPaneKey[PANE_KEY].agent = 'claude'
    }
    if (reason === 'shell') {
      state.paneForegroundAgentByPaneKey[PANE_KEY].shellForeground = true
    }
    if (reason === 'revoked') {
      state.paneForegroundAgentByPaneKey[PANE_KEY].routingRevoked = true
    }
    if (reason === 'unknown') {
      delete state.paneForegroundAgentByPaneKey[PANE_KEY]
    }
    if (reason === 'restored') {
      delete state.paneForegroundAgentByPaneKey[PANE_KEY]
      state.agentStatusByPaneKey[PANE_KEY] = { agentType: 'codex', restoredUnconfirmed: true }
    }
    if (reason === 'sibling') {
      state.paneForegroundAgentByPaneKey = {
        'another-pane': { agent: 'codex', shellForeground: false }
      }
    }
    const pane = await openPane()
    await pane.drag()
    expect(pane.emitted.some((data) => data.startsWith('\x1b[<'))).toBe(true)
    expect(writeClipboardText).not.toHaveBeenCalled()
  })
})
