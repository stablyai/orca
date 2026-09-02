// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createTerminalKeyboardEventHandlers } from './terminal-keyboard-event-handlers'

describe('terminal keyboard pane ownership', () => {
  it('submits Enter through the helper textarea pane when active state is stale', () => {
    const scope = document.createElement('div')
    const firstElement = document.createElement('div')
    const focusedElement = document.createElement('div')
    const focusedInput = document.createElement('textarea')
    focusedInput.className = 'xterm-helper-textarea'
    focusedElement.appendChild(focusedInput)
    scope.append(firstElement, focusedElement)
    document.body.appendChild(scope)

    const first = { id: 1, leafId: 'leaf-1', terminal: { element: firstElement } }
    const focused = { id: 2, leafId: 'leaf-2', terminal: { element: focusedElement } }
    let active = first
    const setActivePane = vi.fn((paneId: number) => {
      active = paneId === focused.id ? focused : first
    })
    const sendFocused = vi.fn()
    const handlers = createTerminalKeyboardEventHandlers({
      isMac: false,
      isWindows: false,
      shortcutPlatform: 'linux',
      keyboardScopeRef: { current: scope },
      resolveShortcutEvent: () => ({ type: 'sendInput', data: '\r' }),
      createCapturedInputSender: (pane) => (pane.id === focused.id ? sendFocused : vi.fn()),
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
          getActivePane: () => active,
          getPanes: () => [first, focused],
          setActivePane
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
      setSearchOpen: vi.fn(),
      onSearchSelectedText: vi.fn(),
      onRequestClosePane: vi.fn(),
      onClearPaneScrollback: vi.fn(),
      onSetTitle: vi.fn(),
      onClearPaneTitle: vi.fn(),
      searchOpenRef: { current: false },
      searchStateRef: { current: { query: '', caseSensitive: false, regex: false } },
      keybindings: undefined,
      terminalShortcutPolicy: 'orca-first',
      getKeyboardSplitTelemetrySource: () => 'keyboard'
    } as never)

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter'
    })
    Object.defineProperty(event, 'keyCode', { value: 13 })
    focusedInput.dispatchEvent(event)
    handlers.onKeyDown(event)

    expect(setActivePane).toHaveBeenCalledWith(2, { focus: false })
    expect(sendFocused).toHaveBeenCalledOnce()
  })
})
