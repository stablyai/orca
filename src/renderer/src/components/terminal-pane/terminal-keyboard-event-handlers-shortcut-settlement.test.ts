// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalKeyboardEventHandlers } from './terminal-keyboard-event-handlers'

function createHarness(action: Record<string, unknown>) {
  const scope = document.createElement('div')
  const paneElement = document.createElement('div')
  const input = document.createElement('textarea')
  input.className = 'xterm-helper-textarea'
  paneElement.appendChild(input)
  scope.appendChild(paneElement)
  document.body.appendChild(scope)

  const pane = { id: 1, leafId: 'leaf-1', terminal: { element: paneElement } }
  const oldTransport = { id: 'old' }
  const paneTransportsRef = { current: new Map([[pane.id, oldTransport]]) }
  const panePtyBindingsRef = { current: new Map<number, unknown>() }
  const delivered: { transport: unknown; data: string }[] = []
  const deferredNewlineSender = {
    absorbRedispatchedEnter: () => false,
    defer: vi.fn()
  }
  const optionKittyReleases = { arm: vi.fn(), armNativeDeadKey: vi.fn() }
  const createCapturedInputSender = vi.fn((targetPane: typeof pane, data: string) => {
    const capturedTransport = paneTransportsRef.current.get(targetPane.id)
    return (overrideData = data): void => {
      delivered.push({ transport: capturedTransport, data: overrideData })
    }
  })
  const handlers = createTerminalKeyboardEventHandlers({
    isMac: true,
    isWindows: false,
    shortcutPlatform: 'darwin',
    keyboardScopeRef: { current: scope },
    resolveShortcutEvent: () => action,
    createCapturedInputSender,
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
    deferredNewlineSender,
    deferredChordSender: { defer: vi.fn() },
    getModifiedEnterChord: () => null,
    reconcileHeldImeEnterModifiers: vi.fn(),
    optionKittyReleases,
    terminalImeEnterModifierKeydowns: new Set(),
    paneKittyKeyboardModesRef: { current: new Map([[pane.id, { flags: 3 }]]) },
    managerRef: {
      current: {
        getActivePane: () => pane,
        getPanes: () => [pane],
        setActivePane: vi.fn()
      }
    },
    paneTransportsRef,
    panePtyBindingsRef,
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

  return {
    handlers,
    input,
    pane,
    oldTransport,
    paneTransportsRef,
    panePtyBindingsRef,
    delivered,
    deferredNewlineSender,
    optionKittyReleases
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('terminal Kitty shortcut settlement routing', () => {
  it('resolves the current binding and transport when deferred input flushes', () => {
    const harness = createHarness({
      type: 'sendInput',
      data: '\x1b\r',
      kittyKeyboardInput: { kitty: '\x1b[13;2u', legacy: '\x1b\r' }
    })
    const oldDispatch = vi.fn(() => false)
    const replacementDispatch = vi.fn(
      (shortcut: { kitty: string }, send: (data: string) => void) => {
        send(shortcut.kitty)
        return true
      }
    )
    harness.panePtyBindingsRef.current.set(harness.pane.id, {
      dispatchKittyShortcutInput: oldDispatch
    })
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
      shiftKey: true,
      isComposing: true
    })
    Object.defineProperty(event, 'keyCode', { value: 13 })
    harness.input.dispatchEvent(event)
    harness.handlers.onKeyDown(event)

    const replacementTransport = { id: 'replacement' }
    harness.paneTransportsRef.current.set(harness.pane.id, replacementTransport)
    harness.panePtyBindingsRef.current.set(harness.pane.id, {
      dispatchKittyShortcutInput: replacementDispatch
    })
    const deferredSend = harness.deferredNewlineSender.defer.mock.calls[0]?.[2]
    expect(deferredSend).toBeTypeOf('function')
    deferredSend()

    expect(oldDispatch).not.toHaveBeenCalled()
    expect(replacementDispatch).toHaveBeenCalledOnce()
    expect(harness.delivered).toEqual([{ transport: replacementTransport, data: '\x1b[13;2u' }])
  })

  it('routes the computed Option key release through settlement without rewriting it', () => {
    const press = '\x1b[57414;3u'
    const release = '\x1b[57414;3:3u'
    const harness = createHarness({
      type: 'sendInput',
      data: press,
      kittyKeyboardInput: { kitty: press, legacy: '\r' },
      optionKittyRelease: { flags: 2 }
    })
    const settledInputs: { kitty: string; legacy: string }[] = []
    harness.panePtyBindingsRef.current.set(harness.pane.id, {
      dispatchKittyShortcutInput: (
        shortcut: { kitty: string; legacy: string },
        send: (data: string) => void
      ) => {
        settledInputs.push(shortcut)
        send(shortcut.kitty)
        return true
      }
    })
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'NumpadEnter',
      altKey: true
    })
    harness.input.dispatchEvent(event)
    harness.handlers.onKeyDown(event)

    const releaseSender = harness.optionKittyReleases.arm.mock.calls[0]?.[2]
    expect(releaseSender).toBeTypeOf('function')
    releaseSender(release)

    expect(settledInputs).toEqual([
      { kitty: press, legacy: '\r' },
      { kitty: release, legacy: release }
    ])
    expect(harness.delivered.map(({ data }) => data)).toEqual([press, release])
  })
})
