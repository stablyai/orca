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

function createHarness(): {
  deps: KeyboardHandlersDeps
  terminalElement: HTMLDivElement
  terminalInput: HTMLTextAreaElement
  /** Every byte reaching the pty, in arrival order, whichever route it took. */
  wire: string[]
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

  // The gesture runs to its release because a chord the IME swallowed is only resolvable there:
  // on the keydown, Korean's committing source and Japanese's swallowing one are byte-identical,
  // and acting on both would fire Korean's twice once the platform replays it. Recorded on macOS
  // 26.5.1: `Cmd+←` delivers no arrow keyup at all, so the Command release ends it.
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
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keyup', { key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing })
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

  // The Japanese shape: still marked composing when the chord is resolved. The preedit spans
  // several characters here on purpose — a relocated multi-character preedit also overwrote the
  // glyph already at the destination cell, so the whole run has to commit in place first.
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

  /**
   * The Korean 2-Set gesture end to end. The marked press is remembered rather than sent; the
   * syllable commits while the key is still down, so the release arrives already unmarked and the
   * recovery declines it; and the platform then replays the chord for the pane to resolve the
   * ordinary way. One byte per press is the contract — a second one jumps two words.
   */
  function playCommittingChord(
    harness: ReturnType<typeof createHarness>,
    chord: { code: string; keyCode: number; mods: KeyboardEventInit }
  ): void {
    const { code, keyCode, mods } = chord
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', { key: code, code, keyCode: 229, isComposing: true, ...mods })
    )
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keyup', { key: code, code, keyCode, ...mods })
    )
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', { key: code, code, keyCode, ...mods })
    )
  }

  // With "가나 다라 마바" on the line and "사" still composing, each of these relocated the
  // composing syllable to wherever the cursor landed. The Cmd+← cases above reach neither the
  // other direction nor Option's word jump, and each byte is a separate resolver branch.
  it.each([
    {
      name: 'Option+ArrowLeft word jump',
      code: 'ArrowLeft',
      keyCode: 37,
      mods: { altKey: true },
      sent: '\x1bb'
    },
    {
      name: 'Option+ArrowRight word jump',
      code: 'ArrowRight',
      keyCode: 39,
      mods: { altKey: true },
      sent: '\x1bf'
    },
    {
      name: 'Cmd+ArrowRight line-end jump',
      code: 'ArrowRight',
      keyCode: 39,
      mods: { metaKey: true },
      sent: '\x05'
    }
  ])('sends a $name once, behind the syllable it committed', ({ code, keyCode, mods, sent }) => {
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

    harness.startComposition()
    playCommittingChord(harness, { code, keyCode, mods })
    expect(harness.wire, 'nothing may reach the pty while the syllable is pending').toEqual([])

    harness.endComposition('사')
    vi.runAllTimers()

    expect(harness.wire).toEqual(['사', sent])
    hook.unmount()
    harness.dispose()
  })

  // Off macOS the release-keyed recovery never arms, so the chord waits for the commit instead and
  // no release takes part at all. Transcribed from the same macOS session as the cases above rather
  // than captured on win32: what it pins is the resolver's non-mac branch, not the platform.
  it('holds a Windows Ctrl+ArrowLeft word jump behind the composing syllable', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const harness = createHarness()
    const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

    harness.startComposition()
    harness.terminalInput.dispatchEvent(
      keyboardEvent('keydown', {
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 37,
        ctrlKey: true,
        isComposing: true
      })
    )
    expect(harness.wire).toEqual([])

    harness.endComposition('사')
    vi.runAllTimers()

    expect(harness.wire).toEqual(['사', '\x1bb'])
    hook.unmount()
    harness.dispose()
  })
})
