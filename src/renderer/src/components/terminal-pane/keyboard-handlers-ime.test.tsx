// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { useTerminalKeyboardShortcuts } from './keyboard-handlers'
import {
  installTerminalImeCompositionRoute,
  XTERM_COMPOSITION_SESSION_END_EVENT,
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

function createHarness(): {
  deps: KeyboardHandlersDeps
  editable: HTMLInputElement
  /** Both PTY writers in the order they reached the transport: composed glyphs and shortcut bytes. */
  ptyWrites: string[]
  startComposition: () => void
  endComposition: (data: string) => void
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

  const ptyWrites: string[] = []
  const sendInput = vi.fn((data: string) => {
    ptyWrites.push(data)
    return true
  })
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
    terminal: {
      input: (data: string) => {
        ptyWrites.push(data)
      }
    },
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
    editable,
    ptyWrites,
    terminalInput,
    startComposition: () => {
      terminalElement.dispatchEvent(
        new CustomEvent(XTERM_COMPOSITION_SESSION_START_EVENT, {
          detail: { id: 1 }
        })
      )
    },
    endComposition: (data: string) => {
      terminalElement.dispatchEvent(
        new CustomEvent(XTERM_COMPOSITION_SESSION_END_EVENT, {
          cancelable: true,
          detail: { id: 1, data }
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

  // Windows gives a shifted jamo the same Process/229/shiftKey shape as the committing
  // Enter, so treating it as Enter injects a Shift+Enter newline into ordinary Hangul.
  it.each([
    { code: 'KeyQ', jamo: 'ㅃ' },
    { code: 'KeyE', jamo: 'ㄸ' }
  ])('does not read a shifted $jamo as the committing Enter', ({ code, jamo }) => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.startComposition()
    const shiftedJamo = keyboardEvent('keydown', {
      key: 'Process',
      code,
      keyCode: 229,
      timeStamp: 10,
      isComposing: true,
      shiftKey: true
    })

    harness.terminalInput.dispatchEvent(shiftedJamo)
    harness.endComposition(jamo)
    vi.advanceTimersByTime(250)

    expect(harness.ptyWrites).toEqual([jamo])
    expect(shiftedJamo.defaultPrevented).toBe(false)
    hook.unmount()
    harness.dispose()
  })
})

// The committing press repeats and the direct shortcut write races xterm's flush for
// every key the IME owns, not only Enter. Ctrl+Backspace stands in for the rest.
describe('IME-owned shortcut keys other than Enter', () => {
  const CTRL_BACKSPACE = '\x17'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mac')
  })

  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function pressCtrlBackspace(
    harness: ReturnType<typeof createHarness>,
    overrides: { isComposing?: boolean }
  ): KeyboardEvent {
    // The re-dispatch is the same native event, so it carries the original timeStamp.
    const event = keyboardEvent('keydown', {
      key: 'Backspace',
      code: 'Backspace',
      keyCode: 8,
      timeStamp: 10,
      ctrlKey: true,
      ...overrides
    })
    harness.terminalInput.dispatchEvent(event)
    return event
  }

  it('sends one Ctrl+Backspace, behind the syllable it committed', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.startComposition()

    pressCtrlBackspace(harness, { isComposing: true })
    expect(harness.ptyWrites).toEqual([])

    const redispatch = pressCtrlBackspace(harness, {})
    expect(redispatch.defaultPrevented).toBe(true)
    expect(harness.ptyWrites).toEqual([])

    harness.endComposition('녕')
    vi.advanceTimersByTime(1)

    expect(harness.ptyWrites).toEqual(['녕', CTRL_BACKSPACE])
    hook.unmount()
    harness.dispose()
  })

  it('sends Ctrl+Backspace straight through outside a composition', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

    pressCtrlBackspace(harness, {})

    expect(harness.ptyWrites).toEqual([CTRL_BACKSPACE])
    hook.unmount()
    harness.dispose()
  })
})
