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

function createHarness(): {
  deps: KeyboardHandlersDeps
  editable: HTMLInputElement
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
})
