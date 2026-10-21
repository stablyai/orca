// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { createTerminalKeyboardEventHandlers } from './terminal-keyboard-event-handlers'
import type { TerminalShortcutAction } from './terminal-shortcut-policy'

function createHandlers(
  scope: HTMLElement,
  setSearchOpen: (open: boolean) => void,
  {
    action = { type: 'toggleSearch' },
    keybindings,
    onClearPaneScrollback = vi.fn(),
    terminal = {}
  }: {
    action?: TerminalShortcutAction
    keybindings?: KeybindingOverrides
    onClearPaneScrollback?: () => void
    terminal?: { selectAll?: () => void; getSelection?: () => string }
  } = {}
) {
  const pane = { id: 1, leafId: 'leaf-1', terminal: { element: scope, ...terminal } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the complete find path; unused runtime dependencies intentionally remain absent.
  return createTerminalKeyboardEventHandlers({
    isMac: false,
    isWindows: false,
    shortcutPlatform: 'linux',
    keyboardScopeRef: { current: scope },
    resolveShortcutEvent: () => action,
    createCapturedInputSender: () => vi.fn(),
    nativeOnlyShortcutTracker: {
      prepareKeyDown: vi.fn(),
      armKeyDown: vi.fn()
    },
    observedEnterKeydownTimeStamps: new Map(),
    modifiedEnterChordOwner: {
      ownsRedispatchedEnter: () => false,
      absorb: () => false,
      claim: () => true
    },
    deferredNewlineSender: {
      absorbRedispatchedEnter: () => false,
      defer: vi.fn()
    },
    deferredChordSender: { defer: vi.fn() },
    getModifiedEnterChord: () => null,
    reconcileHeldImeEnterModifiers: vi.fn(),
    optionKittyReleases: { arm: vi.fn(), armNativeDeadKey: vi.fn() },
    terminalImeEnterModifierKeydowns: new Set(),
    paneKittyKeyboardModesRef: { current: new Map() },
    managerRef: {
      current: {
        getActivePane: () => pane,
        getPanes: () => [pane],
        setActivePane: vi.fn()
      }
    },
    paneTransportsRef: { current: new Map() },
    panePtyBindingsRef: { current: new Map() },
    paneCwdRef: { current: new Map() },
    tabId: 'tab-1',
    worktreeId: 'worktree-1',
    fallbackCwd: '',
    expandedPaneIdRef: { current: null },
    setExpandedPane: vi.fn(),
    restoreExpandedLayout: vi.fn(),
    refreshPaneSizes: vi.fn(),
    persistLayoutSnapshot: vi.fn(),
    toggleExpandPane: vi.fn(),
    setSearchOpen,
    focusSearchInput: vi.fn(),
    onSearchSelectedText: vi.fn(),
    onRequestClosePane: vi.fn(),
    onClearPaneScrollback,
    onSetTitle: vi.fn(),
    onClearPaneTitle: vi.fn(),
    searchOpenRef: { current: false },
    searchStateRef: {
      current: { query: '', caseSensitive: false, regex: false }
    },
    keybindings,
    terminalShortcutPolicy: 'orca-first',
    getKeyboardSplitTelemetrySource: () => 'keyboard'
  } as never)
}

function pressChord(
  target: HTMLElement,
  handlers: ReturnType<typeof createHandlers>,
  key = 'f'
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: true
  })
  target.dispatchEvent(event)
  handlers.onKeyDown(event)
  return event
}

function mountCoveredPane(): { scope: HTMLElement; transcript: HTMLElement } {
  const scope = document.createElement('div')
  const cover = document.createElement('div')
  cover.className = 'native-chat-pane-shell'
  const transcript = document.createElement('div')
  cover.append(transcript)
  scope.append(cover)
  document.body.append(scope)
  return { scope, transcript }
}

describe('terminal selection under a native chat cover', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('leaves copy to the chat when the hidden terminal still holds a selection', () => {
    const { scope, transcript } = mountCoveredPane()
    const writeTerminalClipboardText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('api', { ui: { writeTerminalClipboardText } })
    const handlers = createHandlers(scope, vi.fn(), {
      action: { type: 'copySelection' },
      terminal: { getSelection: () => 'hidden terminal text' }
    })

    expect(pressChord(transcript, handlers, 'c').defaultPrevented).toBe(false)
    expect(writeTerminalClipboardText).not.toHaveBeenCalled()

    expect(pressChord(scope, handlers, 'c').defaultPrevented).toBe(true)
    expect(writeTerminalClipboardText).toHaveBeenCalledWith('hidden terminal text')
  })

  it('does not select the hidden terminal from the chat', () => {
    const { scope, transcript } = mountCoveredPane()
    const selectAll = vi.fn()
    const handlers = createHandlers(scope, vi.fn(), {
      action: { type: 'selectAll' },
      terminal: { selectAll }
    })

    expect(pressChord(transcript, handlers, 'a').defaultPrevented).toBe(false)
    expect(selectAll).not.toHaveBeenCalled()

    pressChord(scope, handlers, 'a')
    expect(selectAll).toHaveBeenCalledTimes(1)
  })
})

describe('terminal find under a native chat cover', () => {
  it('leaves Mod+F to the chat instead of opening search over the hidden terminal', () => {
    const scope = document.createElement('div')
    const cover = document.createElement('div')
    cover.className = 'native-chat-pane-shell'
    const transcript = document.createElement('div')
    cover.append(transcript)
    scope.append(cover)
    document.body.append(scope)
    const setSearchOpen = vi.fn()
    const handlers = createHandlers(scope, setSearchOpen)

    expect(pressChord(transcript, handlers).defaultPrevented).toBe(false)
    expect(setSearchOpen).not.toHaveBeenCalled()

    pressChord(scope, handlers)
    expect(setSearchOpen).toHaveBeenCalledWith(true)
  })

  it('leaves a chat.find rebound onto another terminal chord to the chat', () => {
    const scope = document.createElement('div')
    const cover = document.createElement('div')
    cover.className = 'native-chat-pane-shell'
    const transcript = document.createElement('div')
    cover.append(transcript)
    scope.append(cover)
    document.body.append(scope)
    const onClearPaneScrollback = vi.fn()
    const handlers = createHandlers(scope, vi.fn(), {
      action: { type: 'clearActivePane' },
      keybindings: { 'chat.find': ['Ctrl+K'] },
      onClearPaneScrollback
    })

    expect(pressChord(transcript, handlers, 'k').defaultPrevented).toBe(false)
    expect(onClearPaneScrollback).not.toHaveBeenCalled()

    pressChord(scope, handlers, 'k')
    expect(onClearPaneScrollback).toHaveBeenCalledTimes(1)
  })
})
