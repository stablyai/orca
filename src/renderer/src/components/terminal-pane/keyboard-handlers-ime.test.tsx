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

  it.each([
    // Why: an active IME reports every consumed key as Process/229, e.g. Shift+ㅃ or an MS-IME Ctrl chord.
    { label: 'Shift+KeyQ', code: 'KeyQ', modifier: { shiftKey: true } },
    { label: 'Shift+KeyO', code: 'KeyO', modifier: { shiftKey: true } },
    // Ctrl+K / Ctrl+W are bound on Windows, so a leaked Process chord would clear or close the pane.
    { label: 'Ctrl+KeyK', code: 'KeyK', modifier: { ctrlKey: true } },
    { label: 'Ctrl+KeyW', code: 'KeyW', modifier: { ctrlKey: true } }
  ])('does not treat IME-consumed $label as modified Enter or a shortcut', ({ code, modifier }) => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.startComposition()
    const consumed = keyboardEvent('keydown', {
      key: 'Process',
      code,
      keyCode: 229,
      timeStamp: 10,
      isComposing: true,
      ...modifier
    })

    harness.terminalInput.dispatchEvent(consumed)
    vi.runAllTimers()

    expect(consumed.defaultPrevented).toBe(false)
    expect(harness.sendInput).not.toHaveBeenCalled()
    expect(harness.deps.onClearPaneScrollback).not.toHaveBeenCalled()
    expect(harness.deps.onRequestClosePane).not.toHaveBeenCalled()
    hook.unmount()
    harness.dispose()
  })

  it.each([
    { label: 'Ctrl+KeyK', code: 'KeyK' },
    { label: 'Ctrl+KeyW', code: 'KeyW' }
  ])('stops an IME-consumed $label from reaching window-level shortcuts', ({ code }) => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    const windowHandler = vi.fn()
    window.addEventListener('keydown', windowHandler)
    harness.startComposition()

    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Process',
        code,
        keyCode: 229,
        timeStamp: 10,
        isComposing: true,
        ctrlKey: true
      })
    )
    vi.runAllTimers()

    expect(windowHandler).not.toHaveBeenCalled()
    window.removeEventListener('keydown', windowHandler)
    hook.unmount()
    harness.dispose()
  })

  it.each([{ code: 'Enter' }, { code: 'NumpadEnter' }])(
    'still defers a composed Shift+Enter reported as Process with code $code',
    ({ code }) => {
      const harness = createHarness()
      const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
      harness.startComposition()
      const processEnter = keyboardEvent('keydown', {
        key: 'Process',
        code,
        keyCode: 229,
        timeStamp: 10,
        isComposing: true,
        shiftKey: true
      })

      harness.terminalInput.dispatchEvent(processEnter)

      expect(processEnter.defaultPrevented).toBe(true)
      expect(harness.sendInput).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(harness.sendInput).toHaveBeenCalledWith('\x1b\r')
      hook.unmount()
      harness.dispose()
    }
  )

  // The keyup branch exists for presses whose keydown the IME swallowed entirely.
  // When the keydown WAS observed, release-time modifier state is rollover noise:
  // a plain committing Enter followed by a rolled-over Shift for the next doubled
  // consonant (했다 → commit-Enter, then Shift for ㄸ) must not become Shift+Enter,
  // and a directly-sent Shift+Enter must not send a second newline from its keyup.
  describe('Windows IME Enter-keyup press-time evidence', () => {
    it('does not synthesize a newline from a plain committing Enter with a rolled-over Shift', () => {
      const harness = createHarness()
      const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
      harness.startComposition()

      // Plain committing Enter, consumed by the IME: Process/229, no modifiers.
      harness.terminalInput.dispatchEvent(
        keyboardEvent('keydown', {
          key: 'Process',
          code: 'Enter',
          keyCode: 229,
          timeStamp: 10,
          isComposing: true
        })
      )
      // Rollover: Shift pressed for the next doubled consonant before the Enter keyup.
      harness.terminalInput.dispatchEvent(
        keyboardEvent('keydown', {
          key: 'Shift',
          code: 'ShiftLeft',
          keyCode: 16,
          timeStamp: 20,
          shiftKey: true
        })
      )
      // The Enter keyup reports release-time shiftKey=true while the session is
      // still pending (the session-end finalizer is delayed under renderer lag).
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
      // Balancing keyup copied from the same native event (same timeStamp).
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
      // The physical release arrives later with the rolled-over Shift held.
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

    it('still synthesizes a newline when the IME swallowed the Enter keydown entirely', () => {
      const harness = createHarness()
      const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
      harness.startComposition()

      // No Enter keydown was ever observed: only the keyup arrives, with the
      // chord modifier still held. This is the case the keyup path exists for.
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

    it('does not send a second newline from the keyup of a directly-sent Shift+Enter', () => {
      const harness = createHarness()
      const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

      // No composition yet: Shift+Enter keydown is sent directly.
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

      // The user starts the next Hangul syllable before releasing Enter/Shift.
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
})
