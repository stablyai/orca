// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
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

function createHarness(options: { staleActivePane?: boolean } = {}): {
  deps: KeyboardHandlersDeps
  sendInput: ReturnType<typeof vi.fn>
  setActivePane: ReturnType<typeof vi.fn>
  startComposition: () => void
  terminalInput: HTMLTextAreaElement
  dispose: () => void
} {
  const scope = document.createElement('div')
  const terminalElement = document.createElement('div')
  const terminalInput = document.createElement('textarea')
  terminalInput.className = 'xterm-helper-textarea'
  terminalElement.append(terminalInput)
  const staleTerminalElement = document.createElement('div')
  scope.append(staleTerminalElement, terminalElement)
  document.body.append(scope)

  const sendInput = vi.fn(() => true)
  const transport = {
    getPtyId: () => 'pty-1',
    sendInput
  } as unknown as PtyTransport
  const pane = {
    id: options.staleActivePane ? 2 : 1,
    leafId: '00000000-0000-4000-8000-000000000001',
    terminal: {
      element: terminalElement,
      focus: vi.fn(),
      getSelection: vi.fn(() => '')
    }
  }
  const stalePane = {
    id: 1,
    leafId: '00000000-0000-4000-8000-000000000002',
    terminal: {
      element: staleTerminalElement,
      focus: vi.fn(),
      getSelection: vi.fn(() => '')
    }
  }
  let activePane = options.staleActivePane ? stalePane : pane
  const panes = options.staleActivePane ? [stalePane, pane] : [pane]
  const setActivePane = vi.fn((paneId: number) => {
    activePane = panes.find((candidate) => candidate.id === paneId) ?? activePane
  })
  const manager = {
    getActivePane: () => activePane,
    getPanes: () => panes,
    setActivePane
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
    panePtyBindingsRef: { current: new Map() },
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
    sendInput,
    setActivePane,
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

describe('Windows IME Enter-keyup press-time evidence', () => {
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

  it('does not synthesize a newline from a plain committing Enter with a rolled-over Shift', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.startComposition()

    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Process',
        code: 'Enter',
        keyCode: 229,
        timeStamp: 10,
        isComposing: true
      })
    )
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Shift',
        code: 'ShiftLeft',
        keyCode: 16,
        timeStamp: 20,
        shiftKey: true
      })
    )
    // Release-time Shift belongs to the next doubled consonant.
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        timeStamp: 30,
        shiftKey: true
      })
    )
    vi.runAllTimers()

    expect(harness.sendInput).not.toHaveBeenCalled()
    hook.unmount()
    harness.dispose()
  })

  it('keeps suppression across a balancing keyup that copies the keydown timeStamp', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.startComposition()

    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Process',
        code: 'Enter',
        keyCode: 229,
        timeStamp: 10,
        isComposing: true
      })
    )
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        timeStamp: 10
      })
    )
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Shift',
        code: 'ShiftLeft',
        keyCode: 16,
        timeStamp: 20,
        shiftKey: true
      })
    )
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        timeStamp: 30,
        shiftKey: true
      })
    )
    vi.runAllTimers()

    expect(harness.sendInput).not.toHaveBeenCalled()
    hook.unmount()
    harness.dispose()
  })

  it('guards every keyup of a rapid double Enter press', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.startComposition()

    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Process',
        code: 'Enter',
        keyCode: 229,
        timeStamp: 10,
        isComposing: true
      })
    )
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Process',
        code: 'Enter',
        keyCode: 229,
        timeStamp: 20,
        isComposing: true
      })
    )
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Shift',
        code: 'ShiftLeft',
        keyCode: 16,
        timeStamp: 25,
        shiftKey: true
      })
    )
    for (const timeStamp of [30, 40]) {
      harness.terminalInput.dispatchEvent(
        keyboardEvent('keyup', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          timeStamp,
          shiftKey: true
        })
      )
    }
    vi.runAllTimers()

    expect(harness.sendInput).not.toHaveBeenCalled()
    hook.unmount()
    harness.dispose()
  })

  it('drains one press worth of evidence per release, so a later swallowed keydown still synthesizes', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.startComposition()

    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Process',
        code: 'Enter',
        keyCode: 229,
        timeStamp: 10,
        isComposing: true
      })
    )
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Process',
        code: 'Enter',
        keyCode: 229,
        timeStamp: 20,
        isComposing: true,
        repeat: true
      })
    )
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        timeStamp: 30,
        shiftKey: true
      })
    )
    vi.runAllTimers()
    expect(harness.sendInput).not.toHaveBeenCalled()

    harness.terminalInput.dispatchEvent(
      keyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        timeStamp: 50,
        shiftKey: true
      })
    )
    vi.runAllTimers()

    expect(harness.sendInput).toHaveBeenCalledTimes(1)
    expect(harness.sendInput).toHaveBeenCalledWith('\x1b\r')
    hook.unmount()
    harness.dispose()
  })

  it('still synthesizes a newline when the IME swallowed the Enter keydown entirely', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.startComposition()

    // No keydown evidence: preserve the swallowed-keydown fallback.
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        timeStamp: 30,
        shiftKey: true
      })
    )
    vi.runAllTimers()

    expect(harness.sendInput).toHaveBeenCalledTimes(1)
    expect(harness.sendInput).toHaveBeenCalledWith('\x1b\r')
    hook.unmount()
    harness.dispose()
  })

  it('routes a swallowed Enter keydown fallback to the focused pane and repairs stale active state', () => {
    const harness = createHarness({ staleActivePane: true })
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.startComposition()

    harness.terminalInput.dispatchEvent(
      keyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        timeStamp: 30,
        shiftKey: true
      })
    )
    vi.runAllTimers()

    expect(harness.setActivePane).toHaveBeenCalledWith(2, { focus: false })
    expect(harness.sendInput).toHaveBeenCalledOnce()
    expect(harness.sendInput).toHaveBeenCalledWith('\x1b\r')
    hook.unmount()
    harness.dispose()
  })

  it('does not send a second newline from the keyup of a directly-sent Shift+Enter', () => {
    const harness = createHarness()
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

    harness.startComposition()
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        timeStamp: 30,
        shiftKey: true
      })
    )
    vi.runAllTimers()

    expect(harness.sendInput).toHaveBeenCalledTimes(1)
    hook.unmount()
    harness.dispose()
  })
})
