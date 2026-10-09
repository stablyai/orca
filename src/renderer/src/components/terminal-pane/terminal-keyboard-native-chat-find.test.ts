// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { createTerminalKeyboardEventHandlers } from './terminal-keyboard-event-handlers'
import type { TerminalShortcutAction } from './terminal-shortcut-policy'

function createHandlers(
  scope: HTMLElement,
  setSearchOpen: (open: boolean) => void,
  {
    action = { type: 'toggleSearch' },
    keybindings,
    onClearPaneScrollback = vi.fn()
  }: {
    action?: TerminalShortcutAction
    keybindings?: KeybindingOverrides
    onClearPaneScrollback?: () => void
  } = {}
) {
  const pane = { id: 1, leafId: 'leaf-1', terminal: { element: scope } }
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

function pressFind(
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

    expect(pressFind(transcript, handlers).defaultPrevented).toBe(false)
    expect(setSearchOpen).not.toHaveBeenCalled()

    pressFind(scope, handlers)
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

    expect(pressFind(transcript, handlers, 'k').defaultPrevented).toBe(false)
    expect(onClearPaneScrollback).not.toHaveBeenCalled()

    pressFind(scope, handlers, 'k')
    expect(onClearPaneScrollback).toHaveBeenCalledTimes(1)
  })
})
