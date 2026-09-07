// @vitest-environment happy-dom
// #12871: a cursor chord pressed while a syllable is still composing reached the pty ahead of the
// text it was typed after. With `가나` on the line, typing `가나다` and pressing Cmd+Left left
// `다가나` — the composing `다` landed at the cursor's destination.
//
// The composed glyph reaches the pty from the composition session-end handler, which runs after
// the chord's keydown. Only Enter was held for that; every other chord went straight out.
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import {
  installTerminalImeCompositionRoute,
  XTERM_COMPOSITION_SESSION_END_EVENT,
  XTERM_COMPOSITION_SESSION_START_EVENT
} from './terminal-ime-composition-route'
import { TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS } from './terminal-ime-deferred-chord'
import { useTerminalKeyboardShortcuts } from './keyboard-handlers'

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
    // The committed glyph takes this route; the chord takes the transport. Both land in `wire`,
    // so the assertion is about their order rather than about either one alone.
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

  // The Korean 2-Set shape: the platform replays the chord unmarked after keyup, so `isComposing`
  // is already false — but xterm has not yet emitted the session end that writes the syllable.
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

  // The Japanese shape: still marked composing when the chord is resolved.
  it('holds the chord while the keydown is still marked composing', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

    harness.startComposition()
    pressCmdArrowLeft(harness, true)
    expect(harness.wire).toEqual([])

    harness.endComposition('日本語')
    vi.runAllTimers()

    expect(harness.wire).toEqual(['日本語', '\x01'])
    hook.unmount()
    harness.dispose()
  })

  // A conversion can hold its candidate window open for seconds. A timer that fired mid-preedit
  // would put the chord back ahead of the text, which is the whole defect.
  it('does not fall back to a timer while the composition is still open', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

    harness.startComposition()
    pressCmdArrowLeft(harness, true)
    vi.advanceTimersByTime(30_000)

    expect(harness.wire).toEqual([])
    hook.unmount()
    harness.dispose()
  })

  it('sends immediately when no composition is in flight', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

    pressCmdArrowLeft(harness, false)

    expect(harness.wire).toEqual(['\x01'])
    hook.unmount()
    harness.dispose()
  })

  // STA-4476: an indefinite wait has no exit of its own. Without a disposer the listeners outlive
  // the pane and a later composition on the same element flushes the stale chord.
  it('drops the held chord and its listeners when the pane tears down', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

    harness.startComposition()
    pressCmdArrowLeft(harness, true)
    expect(harness.deferralListenerCount()).toBeGreaterThan(0)

    hook.unmount()
    harness.endComposition('다')
    vi.runAllTimers()

    expect(harness.wire).toEqual(['다'])
    expect(harness.deferralListenerCount()).toBe(0)
    harness.dispose()
  })

  it('drops the held chord and its listeners on blur', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

    harness.startComposition()
    pressCmdArrowLeft(harness, true)
    window.dispatchEvent(new Event('blur'))
    harness.endComposition('다')
    vi.runAllTimers()

    expect(harness.wire).toEqual(['다'])
    expect(harness.deferralListenerCount()).toBe(0)
    hook.unmount()
    harness.dispose()
  })

  // A composition that never commits must not strand the wait forever. The chord is discarded,
  // never sent late — a late send is #12871 again.
  it('abandons a chord whose composition never ends', () => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

    harness.startComposition()
    pressCmdArrowLeft(harness, true)
    vi.advanceTimersByTime(TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS + 1)
    harness.endComposition('다')
    vi.runAllTimers()

    expect(harness.wire).toEqual(['다'])
    expect(harness.deferralListenerCount()).toBe(0)
    hook.unmount()
    harness.dispose()
  })
})
