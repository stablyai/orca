// @vitest-environment happy-dom
// Hold cursor chords until composition writes the syllable, preventing the chord from moving it to the wrong position.
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../pty-transport/pty-transport-types'
import {
  installTerminalImeCompositionRoute,
  XTERM_COMPOSITION_SESSION_END_EVENT,
  XTERM_COMPOSITION_SESSION_START_EVENT
} from './ime/terminal-ime-composition-route'

import { useTerminalKeyboardShortcuts } from './keyboard/terminal-keyboard-hook'

type KeyboardHandlersDeps = Parameters<typeof useTerminalKeyboardShortcuts>[0]

function keyboardEvent(
  type: string,
  overrides: { isComposing?: boolean; keyCode?: number } & KeyboardEventInit
): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...overrides })
  Object.defineProperties(event, {
    isComposing: { value: overrides.isComposing ?? false },
    keyCode: { value: overrides.keyCode ?? 0 }
  })
  return event
}

/** Live registrations on the terminal element, so a deferral that never disposes is visible. */
function trackCompositionListeners(element: HTMLElement): () => number {
  const live = new Set<EventListenerOrEventListenerObject>()
  const watched = new Set(['compositionend', XTERM_COMPOSITION_SESSION_END_EVENT])
  const { addEventListener, removeEventListener } = element
  element.addEventListener = function (type, listener, options): void {
    if (watched.has(type) && listener) {
      live.add(listener)
    }
    addEventListener.call(this, type, listener, options)
  }
  element.removeEventListener = function (type, listener, options): void {
    if (watched.has(type) && listener) {
      live.delete(listener)
    }
    removeEventListener.call(this, type, listener, options)
  }
  return () => live.size
}

function createHarness(): {
  deps: KeyboardHandlersDeps
  terminalElement: HTMLDivElement
  terminalInput: HTMLTextAreaElement
  /** Every byte reaching the pty, in arrival order, whichever route it took. */
  wire: string[]
  /** Registrations added after the composition route's own, i.e. the deferrals still waiting. */
  deferralListenerCount: () => number
  startComposition: () => void
  endComposition: (data: string) => void
  dispose: () => void
} {
  const scope = document.createElement('div')
  const terminalElement = document.createElement('div')
  const terminalInput = document.createElement('textarea')
  terminalInput.className = 'xterm-helper-textarea'
  terminalElement.append(terminalInput)
  scope.append(terminalElement)
  document.body.append(scope)

  const wire: string[] = []
  const transport = {
    getPtyId: () => 'pty-1',
    sendInput: (data: string) => {
      wire.push(data)
      return true
    }
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
    // Feed composition and transport bytes into one wire log to assert their actual ordering.
    terminal: { input: (data: string) => void wire.push(data) },
    capturedTransport: transport,
    getCurrentTransport: () => transport
  })
  // Installed after the route so only the deferral's own registrations are counted.
  const deferralListenerCount = trackCompositionListeners(terminalElement)

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
    focusSearchInput: vi.fn(),
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
    terminalElement,
    terminalInput,
    wire,
    deferralListenerCount,
    startComposition: () => {
      terminalElement.dispatchEvent(
        new CustomEvent(XTERM_COMPOSITION_SESSION_START_EVENT, { detail: { id: 1 } })
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

describe('a cursor chord pressed during a composition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    )
  })

  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function pressCmdArrowLeft(
    harness: ReturnType<typeof createHarness>,
    isComposing: boolean
  ): void {
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 37,
        metaKey: true,
        isComposing
      })
    )
  }

  // Korean chord replay may clear isComposing before xterm emits the session end that writes the syllable.
  it('sends the composed syllable before the chord, not after it', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

    harness.startComposition()
    pressCmdArrowLeft(harness, false)
    expect(harness.wire, 'chord must not reach the pty while the glyph is pending').toEqual([])

    harness.endComposition('다')
    vi.runAllTimers()

    expect(harness.wire).toEqual(['다', '\x01'])
    hook.unmount()
    harness.dispose()
  })

  function pressOptionArrowLeft(
    harness: ReturnType<typeof createHarness>,
    press: { isComposing: boolean; keyCode: number; timeStamp: number }
  ): void {
    const event = keyboardEvent('keydown', {
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      keyCode: press.keyCode,
      altKey: true,
      isComposing: press.isComposing
    })
    Object.defineProperty(event, 'timeStamp', { value: press.timeStamp })
    harness.terminalInput.dispatchEvent(event)
  }

  // Chromium (crbug.com/48161): the IME's composing keydown, the commit, then the same NSEvent replayed unmarked.
  it.each([
    ['before xterm ends the session', false],
    ['after xterm ends the session', true]
  ])('sends a chord the IME replays %s once (#17616)', (_label, sessionEndedFirst) => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

    harness.startComposition()
    pressOptionArrowLeft(harness, { isComposing: true, keyCode: 229, timeStamp: 23884 })
    harness.terminalElement.dispatchEvent(new Event('compositionend'))
    if (sessionEndedFirst) {
      harness.endComposition('사')
    }
    pressOptionArrowLeft(harness, { isComposing: false, keyCode: 37, timeStamp: 23884 })
    if (!sessionEndedFirst) {
      harness.endComposition('사')
    }
    vi.runAllTimers()
    expect(harness.wire).toEqual(['사', '\x1bb'])

    pressOptionArrowLeft(harness, { isComposing: false, keyCode: 37, timeStamp: 23999 })
    expect(harness.wire, 'a genuine next press is not a replay').toEqual(['사', '\x1bb', '\x1bb'])
    hook.unmount()
    harness.dispose()
  })
})
