// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { useExpandCollapseActions } from './expand-collapse'
import { useTerminalKeyboardShortcuts } from './keyboard-handlers'
import {
  installTerminalImeCompositionRoute,
  XTERM_COMPOSITION_SESSION_START_EVENT
} from './terminal-ime-composition-route'

type KeyboardHandlersDeps = Parameters<typeof useTerminalKeyboardShortcuts>[0]

function keyboardEvent(
  type: 'keydown' | 'keyup',
  overrides: KeyboardEventInit & { keyCode: number; timeStamp: number; isComposing?: boolean }
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...overrides
  })
  Object.defineProperties(event, {
    isComposing: { value: overrides.isComposing ?? false },
    keyCode: { value: overrides.keyCode },
    timeStamp: { value: overrides.timeStamp }
  })
  return event
}

type ShortcutBinding = { markShortcutTerminalInputSent: ReturnType<typeof vi.fn> }

function createHarness(bindings?: Map<number, ShortcutBinding>): {
  deps: KeyboardHandlersDeps
  editable: HTMLInputElement
  sendInput: ReturnType<typeof vi.fn>
  startComposition: () => void
  terminalInput: HTMLTextAreaElement
  dispose: () => void
} {
  const scope = document.createElement('div')
  const terminalElement = document.createElement('div')
  const terminalInput = document.createElement('textarea')
  const editable = document.createElement('input')
  terminalInput.className = 'xterm-helper-textarea'
  terminalElement.append(terminalInput)
  scope.append(terminalElement, editable)
  document.body.append(scope)

  const sendInput = vi.fn(() => true)
  const transport = {
    getPtyId: () => 'pty-1',
    sendInput
  } as unknown as PtyTransport
  const pane = {
    id: 1,
    leafId: '00000000-0000-4000-8000-000000000001',
    terminal: {
      element: terminalElement,
      focus: vi.fn(),
      getSelection: vi.fn(() => '')
    }
  }
  const manager = {
    getActivePane: () => pane,
    getPanes: () => [pane]
  } as unknown as PaneManager
  const route = installTerminalImeCompositionRoute({
    terminalElement,
    terminal: { input: vi.fn() },
    capturedTransport: transport,
    getCurrentTransport: () => transport
  })
  const deps: KeyboardHandlersDeps = {
    tabId: 'tab-1',
    worktreeId: 'worktree-1',
    isActive: true,
    keyboardScopeRef: { current: scope },
    managerRef: { current: manager },
    paneTransportsRef: { current: new Map([[pane.id, transport]]) },
    panePtyBindingsRef: { current: (bindings ?? new Map()) as never },
    paneCwdRef: { current: new Map() },
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
    macOptionAsAltRef: { current: 'false' }
  }
  return {
    deps,
    editable,
    sendInput,
    terminalInput,
    startComposition: () => {
      terminalElement.dispatchEvent(
        new CustomEvent(XTERM_COMPOSITION_SESSION_START_EVENT, {
          detail: { id: 1 }
        })
      )
    },
    dispose: () => {
      route.dispose()
      scope.remove()
    }
  }
}

describe('Windows IME keyboard ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows')
  })

  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([
    { key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifier: { shiftKey: true } },
    { key: 'Control', code: 'ControlLeft', keyCode: 17, modifier: { ctrlKey: true } }
  ])('absorbs a bare Enter redispatch when $key was held before composition', (held) => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: held.key,
        code: held.code,
        keyCode: held.keyCode,
        timeStamp: 1,
        ...held.modifier
      })
    )
    harness.startComposition()
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Process',
        code: 'Enter',
        keyCode: 229,
        timeStamp: 10,
        isComposing: true,
        ...held.modifier
      })
    )

    const redispatch = keyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      timeStamp: 20
    })
    harness.terminalInput.dispatchEvent(redispatch)

    expect(redispatch.defaultPrevented).toBe(true)
    hook.unmount()
    harness.dispose()
  })

  it('marks a captured shortcut send as interactive input', () => {
    const binding = { markShortcutTerminalInputSent: vi.fn() }
    const harness = createHarness(new Map([[1, binding]]))
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        timeStamp: 10,
        shiftKey: true
      })
    )

    expect(harness.sendInput).toHaveBeenCalledTimes(1)
    expect(binding.markShortcutTerminalInputSent).toHaveBeenCalledTimes(1)
    hook.unmount()
    harness.dispose()
  })

  it('does not mark input for a pane binding replaced between capture and send', () => {
    // Why: the sender captures the binding, then re-reads it at send time — a rehomed
    // or reconnected pane must not have its redraw scheduling refreshed by the old one.
    const captured = { markShortcutTerminalInputSent: vi.fn() }
    const replacement = { markShortcutTerminalInputSent: vi.fn() }
    const bindings = new Map([[1, captured]])
    let reads = 0
    bindings.get = ((paneId: number) =>
      paneId === 1 ? (reads++ === 0 ? captured : replacement) : undefined) as never
    const harness = createHarness(bindings)
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        timeStamp: 10,
        shiftKey: true
      })
    )

    expect(harness.sendInput).toHaveBeenCalledTimes(1)
    expect(captured.markShortcutTerminalInputSent).not.toHaveBeenCalled()
    expect(replacement.markShortcutTerminalInputSent).not.toHaveBeenCalled()
    hook.unmount()
    harness.dispose()
  })

  it('does not route an editable-target Enter keyup into the terminal', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.startComposition()
    const keyup = keyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      timeStamp: 10,
      ctrlKey: true
    })

    harness.editable.dispatchEvent(keyup)

    expect(keyup.defaultPrevented).toBe(false)
    hook.unmount()
    harness.dispose()
  })

  it('does not arm a modifier pressed in an editable control', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.editable.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Control',
        code: 'ControlLeft',
        keyCode: 17,
        timeStamp: 1,
        ctrlKey: true
      })
    )
    harness.startComposition()
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Process',
        code: 'Enter',
        keyCode: 229,
        timeStamp: 10,
        isComposing: true,
        ctrlKey: true
      })
    )
    const redispatch = keyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      timeStamp: 20
    })

    harness.terminalInput.dispatchEvent(redispatch)

    expect(redispatch.defaultPrevented).toBe(false)
    hook.unmount()
    harness.dispose()
  })

  it('retains Ctrl ownership when a later-held Shift is released first', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    for (const event of [
      keyboardEvent('keydown', {
        key: 'Control',
        code: 'ControlLeft',
        keyCode: 17,
        timeStamp: 1,
        ctrlKey: true
      }),
      keyboardEvent('keydown', {
        key: 'Shift',
        code: 'ShiftLeft',
        keyCode: 16,
        timeStamp: 2,
        ctrlKey: true,
        shiftKey: true
      }),
      keyboardEvent('keyup', {
        key: 'Shift',
        code: 'ShiftLeft',
        keyCode: 16,
        timeStamp: 3,
        ctrlKey: true
      })
    ]) {
      harness.terminalInput.dispatchEvent(event)
    }
    harness.startComposition()
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Process',
        code: 'Enter',
        keyCode: 229,
        timeStamp: 10,
        isComposing: true,
        ctrlKey: true
      })
    )
    const redispatch = keyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      timeStamp: 20
    })

    harness.terminalInput.dispatchEvent(redispatch)

    expect(redispatch.defaultPrevented).toBe(true)
    hook.unmount()
    harness.dispose()
  })

  it('clears held Shift when an IME-consumed keyup reports Process', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Shift',
        code: 'ShiftLeft',
        keyCode: 16,
        timeStamp: 1,
        shiftKey: true
      })
    )
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keyup', {
        key: 'Process',
        code: 'ShiftLeft',
        keyCode: 229,
        timeStamp: 10,
        isComposing: true
      })
    )
    const enter = keyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      timeStamp: 20
    })

    harness.terminalInput.dispatchEvent(enter)

    expect(enter.defaultPrevented).toBe(false)
    hook.unmount()
    harness.dispose()
  })

  it.each([
    { code: 'ShiftLeft', shiftKey: true },
    { code: 'KeyQ', shiftKey: true },
    { code: 'KeyW', ctrlKey: true }
  ])('keeps an IME-consumed $code out of terminal shortcuts', (modifier) => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    const laterWindowHandler = vi.fn()
    window.addEventListener('keydown', laterWindowHandler)
    harness.startComposition()
    const consumed = keyboardEvent('keydown', {
      key: 'Process',
      keyCode: 229,
      timeStamp: 10,
      isComposing: true,
      ...modifier
    })

    harness.terminalInput.dispatchEvent(consumed)

    expect(consumed.defaultPrevented).toBe(false)
    expect(harness.sendInput).not.toHaveBeenCalled()
    expect(harness.deps.onRequestClosePane).not.toHaveBeenCalled()
    expect(laterWindowHandler).not.toHaveBeenCalled()
    window.removeEventListener('keydown', laterWindowHandler)
    hook.unmount()
    harness.dispose()
  })

  it('keeps an IME-consumed Ctrl+Shift+F out of file search', () => {
    const harness = createHarness()
    const pane = harness.deps.managerRef.current?.getActivePane()
    vi.mocked(pane!.terminal.getSelection).mockReturnValue('needle')
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.startComposition()

    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Process',
        code: 'KeyF',
        keyCode: 229,
        timeStamp: 10,
        isComposing: true,
        ctrlKey: true,
        shiftKey: true
      })
    )

    expect(harness.deps.onSearchSelectedText).not.toHaveBeenCalled()
    expect(harness.sendInput).not.toHaveBeenCalled()
    hook.unmount()
    harness.dispose()
  })

  // Why: STA-3291 — busy panes render mid-composition (title updates), and the
  // chord owner must survive those renders or held-modifier CJK input leaks
  // newlines. Wiring mirrors TerminalPane: dep objects rebuilt every render.
  it('absorbs the bare Enter redispatch when re-renders land mid-composition', () => {
    const harness = createHarness()
    const factoryFields = {
      expandedPaneIdRef: { current: null },
      expandedStyleSnapshotRef: { current: new Map() },
      containerRef: { current: null },
      managerRef: { current: null },
      setExpandedPaneId: vi.fn(),
      setTabPaneExpanded: vi.fn(),
      pendingPaneSizeRefreshFrameIdsRef: { current: [] },
      persistLayoutSnapshot: vi.fn()
    }
    const hook = renderHook(() => {
      const actions = useExpandCollapseActions({ ...factoryFields, tabId: 'tab-1' })
      useTerminalKeyboardShortcuts({
        ...harness.deps,
        setExpandedPane: actions.setExpandedPane,
        restoreExpandedLayout: actions.restoreExpandedLayout,
        refreshPaneSizes: actions.refreshPaneSizes,
        toggleExpandPane: actions.toggleExpandPane
      })
    })

    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Shift',
        code: 'ShiftLeft',
        keyCode: 16,
        timeStamp: 1,
        shiftKey: true
      })
    )
    hook.rerender()
    harness.startComposition()
    hook.rerender()
    for (let repeat = 0; repeat < 5; repeat++) {
      harness.terminalInput.dispatchEvent(
        keyboardEvent('keydown', {
          key: 'Process',
          code: 'Enter',
          keyCode: 229,
          timeStamp: 10 + repeat,
          isComposing: true,
          shiftKey: true,
          repeat: repeat > 0
        })
      )
      hook.rerender()
    }

    const redispatch = keyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      timeStamp: 40
    })
    harness.terminalInput.dispatchEvent(redispatch)

    expect(redispatch.defaultPrevented).toBe(true)
    const newlineSends = harness.sendInput.mock.calls.filter(
      ([data]) => typeof data === 'string' && data.includes('\r')
    )
    expect(newlineSends).toHaveLength(0)
    hook.unmount()
    harness.dispose()
  })
})
