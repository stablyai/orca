// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...overrides })
  Object.defineProperties(event, {
    isComposing: { value: overrides.isComposing ?? false },
    keyCode: { value: overrides.keyCode },
    timeStamp: { value: overrides.timeStamp }
  })
  return event
}

function createHarness(): {
  deps: KeyboardHandlersDeps
  order: string[]
  startComposition: () => void
  commitComposition: (data: string) => void
  terminalInput: HTMLTextAreaElement
  dispose: () => void
} {
  const scope = document.createElement('div')
  const terminalElement = document.createElement('div')
  const terminalInput = document.createElement('textarea')
  terminalInput.className = 'xterm-helper-textarea'
  terminalElement.append(terminalInput)
  scope.append(terminalElement)
  document.body.append(scope)

  const order: string[] = []
  const transport = {
    getPtyId: () => 'pty-1',
    sendInput: vi.fn((data: string) => {
      order.push(`pty:${JSON.stringify(data)}`)
      return true
    })
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
      input: vi.fn((data: string) => {
        order.push(`commit:${data}`)
      })
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
    order,
    terminalInput,
    startComposition: () => {
      terminalElement.dispatchEvent(
        new CustomEvent(XTERM_COMPOSITION_SESSION_START_EVENT, { detail: { id: 1 } })
      )
    },
    commitComposition: (data) => {
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

describe('terminal shortcut bytes during an IME composition', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function usePlatform(userAgent: string): void {
    vi.useFakeTimers()
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent)
  }

  // "가" already reached the pty; "나" is still in the preedit. The shell reads
  // these bytes against the line it has, so they must not overtake the commit.
  it.each([
    {
      name: 'Cmd+Backspace line kill',
      key: 'Backspace',
      keyCode: 8,
      mods: { metaKey: true },
      sent: '\x15'
    },
    {
      name: 'Cmd+Delete kill to end',
      key: 'Delete',
      keyCode: 46,
      mods: { metaKey: true },
      sent: '\x0b'
    },
    {
      name: 'Cmd+ArrowLeft line start',
      key: 'ArrowLeft',
      keyCode: 37,
      mods: { metaKey: true },
      sent: '\x01'
    }
  ])('defers a macOS $name until the trailing syllable commits', ({ key, keyCode, mods, sent }) => {
    usePlatform('Macintosh')
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.startComposition()

    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key,
        code: key,
        keyCode,
        timeStamp: 10,
        isComposing: true,
        ...mods
      })
    )
    harness.commitComposition('나')
    vi.runAllTimers()

    expect(harness.order).toEqual(['commit:나', `pty:${JSON.stringify(sent)}`])
    hook.unmount()
    harness.dispose()
  })

  it('defers Ctrl+Backspace word kill on Linux too', () => {
    usePlatform('X11; Linux x86_64')
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
    harness.startComposition()

    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        timeStamp: 10,
        isComposing: true,
        ctrlKey: true
      })
    )
    harness.commitComposition('나')
    vi.runAllTimers()

    expect(harness.order).toEqual(['commit:나', 'pty:"\\u0017"'])
    hook.unmount()
    harness.dispose()
  })

  it('still sends immediately when no composition is pending', () => {
    usePlatform('Macintosh')
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        timeStamp: 10,
        metaKey: true
      })
    )

    expect(harness.order).toEqual(['pty:"\\u0015"'])
    hook.unmount()
    harness.dispose()
  })
})
