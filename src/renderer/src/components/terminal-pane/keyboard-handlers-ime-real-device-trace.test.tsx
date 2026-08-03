// @vitest-environment happy-dom
// Regression suite driven by real-device Windows Korean IME captures.
// Split from keyboard-handlers-ime.test.tsx to stay under the max-lines ratchet.
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

describe('Windows Korean IME real-device captures', () => {
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

  // Replay of a real-device capture (Windows 11 Pro 26200, Microsoft Korean IME
  // 2-beolsik, Orca 1.4.163) typing 있다 with no Enter pressed at any point.
  // Measured rather than assumed: every IME-consumed key arrives as Process/229
  // while `code` still carries the physical key, and Windows reports the Shift
  // press itself that way too — which the pre-fix predicate read as a chord.
  // Source: stablyai/orca#11878.
  describe('real-device 있다 trace', () => {
    const ISSS_DA_TRACE = [
      {
        t: 'keydown',
        key: 'Process',
        code: 'KeyD',
        keyCode: 229,
        ts: 4401,
        shift: false,
        comp: false
      },
      {
        t: 'keydown',
        key: 'Process',
        code: 'KeyL',
        keyCode: 229,
        ts: 4545,
        shift: false,
        comp: true
      },
      {
        t: 'keyup',
        key: 'Process',
        code: 'KeyD',
        keyCode: 229,
        ts: 4548,
        shift: false,
        comp: true
      },
      {
        t: 'keyup',
        key: 'Process',
        code: 'KeyL',
        keyCode: 229,
        ts: 4663,
        shift: false,
        comp: true
      },
      // Chromium delivers the same physical Shift press twice, once as Process/229.
      {
        t: 'keydown',
        key: 'Process',
        code: 'ShiftLeft',
        keyCode: 229,
        ts: 4663,
        shift: true,
        comp: true
      },
      {
        t: 'keydown',
        key: 'Shift',
        code: 'ShiftLeft',
        keyCode: 16,
        ts: 4664,
        shift: true,
        comp: true
      },
      {
        t: 'keydown',
        key: 'Process',
        code: 'KeyT',
        keyCode: 229,
        ts: 4711,
        shift: true,
        comp: true
      },
      {
        t: 'keyup',
        key: 'Process',
        code: 'ShiftLeft',
        keyCode: 229,
        ts: 4873,
        shift: false,
        comp: true
      },
      {
        t: 'keyup',
        key: 'Shift',
        code: 'ShiftLeft',
        keyCode: 16,
        ts: 4873,
        shift: false,
        comp: true
      },
      {
        t: 'keyup',
        key: 'Process',
        code: 'KeyT',
        keyCode: 229,
        ts: 4873,
        shift: false,
        comp: true
      },
      {
        t: 'keydown',
        key: 'Process',
        code: 'KeyE',
        keyCode: 229,
        ts: 5025,
        shift: false,
        comp: true
      },
      {
        t: 'keydown',
        key: 'Process',
        code: 'KeyK',
        keyCode: 229,
        ts: 5097,
        shift: false,
        comp: true
      }
    ] as const

    const replay = (
      harness: ReturnType<typeof createHarness>,
      rows: readonly {
        t: string
        key: string
        code: string
        keyCode: number
        ts: number
        shift: boolean
        ctrl?: boolean
        comp: boolean
      }[]
    ): void => {
      for (const row of rows) {
        harness.terminalInput.dispatchEvent(
          keyboardEvent(row.t as 'keydown' | 'keyup', {
            key: row.key,
            code: row.code,
            keyCode: row.keyCode,
            timeStamp: row.ts,
            shiftKey: row.shift,
            ctrlKey: row.ctrl ?? false,
            isComposing: row.comp
          })
        )
      }
      vi.runAllTimers()
    }

    it('sends nothing for the full 있다 trace, which contains no Enter event', () => {
      const harness = createHarness()
      const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
      harness.startComposition()

      replay(harness, ISSS_DA_TRACE)

      expect(harness.sendInput).not.toHaveBeenCalled()
      hook.unmount()
      harness.dispose()
    })

    // The trigger is not "Shift+jamo" — it is whether a composition session is
    // already open when Shift goes down. These three states are what separate a
    // fix that only satisfies 계획 or a word-initial 빼 from one that holds for
    // ordinary prose: Korean past tense is 았/었/였, so a shifted batchim lands in
    // a large share of real sentences and is mid-composition by construction.
    // Measured on real hardware in stablyai/orca#11878.
    const shiftDown = (ts: number) => ({
      t: 'keydown' as const,
      key: 'Process',
      code: 'ShiftLeft',
      keyCode: 229,
      ts,
      shift: true
    })
    const shiftUp = (ts: number) => ({
      t: 'keyup' as const,
      key: 'Process',
      code: 'ShiftLeft',
      keyCode: 229,
      ts,
      shift: false
    })

    it('stays silent for a word-initial shifted jamo, before any composition opens', () => {
      const harness = createHarness()
      const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))

      // No startComposition(): nothing is composing yet, which is why 빼 on its
      // own has always been safe. This is the negative — the fix must not start
      // suppressing it.
      replay(harness, [
        { ...shiftDown(10), comp: false },
        {
          t: 'keydown',
          key: 'Process',
          code: 'KeyQ',
          keyCode: 229,
          ts: 20,
          shift: true,
          comp: false
        },
        { ...shiftUp(30), comp: true }
      ])

      expect(harness.sendInput).not.toHaveBeenCalled()
      hook.unmount()
      harness.dispose()
    })

    it('sends nothing for a shifted batchim, the common mid-composition case', () => {
      const harness = createHarness()
      const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
      harness.startComposition()

      // 갔: ㄱ and ㅏ are already composing by the time Shift comes down for ㅆ
      // (Shift+t). 갓 takes a plain ㅅ and never reaches this path.
      replay(harness, [
        {
          t: 'keydown',
          key: 'Process',
          code: 'KeyR',
          keyCode: 229,
          ts: 10,
          shift: false,
          comp: false
        },
        {
          t: 'keydown',
          key: 'Process',
          code: 'KeyK',
          keyCode: 229,
          ts: 20,
          shift: false,
          comp: true
        },
        { ...shiftDown(30), comp: true },
        {
          t: 'keydown',
          key: 'Process',
          code: 'KeyT',
          keyCode: 229,
          ts: 40,
          shift: true,
          comp: true
        },
        { ...shiftUp(50), comp: true }
      ])

      expect(harness.sendInput).not.toHaveBeenCalled()
      hook.unmount()
      harness.dispose()
    })

    it('sends nothing for a bare Shift press mid-composition, with no jamo at all', () => {
      const harness = createHarness()
      const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
      harness.startComposition()

      // The pre-fix predicate matched this on its own: Process/229 with shiftKey
      // set and no other modifier reads as a 'shift' chord unless `code` is checked.
      replay(
        harness,
        ISSS_DA_TRACE.filter((row) => row.code === 'ShiftLeft')
      )

      expect(harness.sendInput).not.toHaveBeenCalled()
      hook.unmount()
      harness.dispose()
    })

    // The mechanism is not Shift-specific: Ctrl pressed mid-composition is
    // reported as Process/229 the same way, and getTerminalImeModifiedEnterKind
    // returns 'ctrl' for it, so the pre-fix predicate reached the Ctrl+Enter
    // branch. That branch emits \x1b[13;5u unconditionally with no fallback, so
    // a TUI that has not negotiated the Kitty protocol discards it silently —
    // an injection with nothing visible on screen. Captured on the same probe:
    // the same physical key reports as Process/229 while a session is open and
    // as Control/17 once it has closed.
    // A pty capture of a ~9s modifier hold mid-composition showed repeated
    // injections rather than the single one the chord owner appears to allow.
    // The device event probe ruled out repeated down/up pairs: Windows delivers a
    // hold as one keydown, a long auto-repeat run, and exactly one keyup. The
    // amplifier is effect re-registration — modifiedEnterChordOwner.clear() also
    // runs in the keyboard effect's cleanup, so every teardown/re-register drops
    // the lock and the next auto-repeat keydown claims it again. The injection
    // rate therefore follows the render rate: measured at three per hold in a
    // quiet PowerShell pane and as a continuous stream in a repainting TUI.
    // Source: stablyai/orca#12120.
    it.each([
      ['without a re-render', false],
      ['with a re-render between each repeat', true]
    ])('sends nothing for a held Shift across auto-repeats %s', (_label, reRender) => {
      const harness = createHarness()
      const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
      harness.startComposition()

      const shiftRow = (ts: number, repeat: boolean) =>
        keyboardEvent('keydown', {
          key: 'Process',
          code: 'ShiftLeft',
          keyCode: 229,
          timeStamp: ts,
          isComposing: true,
          shiftKey: true,
          repeat
        })

      let timeStamp = 15503
      harness.terminalInput.dispatchEvent(shiftRow(timeStamp, false))
      harness.terminalInput.dispatchEvent(
        keyboardEvent('keydown', {
          key: 'Shift',
          code: 'ShiftLeft',
          keyCode: 16,
          timeStamp,
          isComposing: true,
          shiftKey: true
        })
      )
      for (let repeat = 0; repeat < 50; repeat += 1) {
        timeStamp += 31
        if (reRender) {
          // Stands in for the app re-rendering mid-hold, which tears the keyboard
          // effect down and back up and clears the chord lock on the way through.
          hook.rerender()
        }
        harness.terminalInput.dispatchEvent(shiftRow(timeStamp, true))
      }
      timeStamp += 24
      for (const [key, keyCode] of [
        ['Process', 229],
        ['Shift', 16]
      ] as const) {
        harness.terminalInput.dispatchEvent(
          keyboardEvent('keyup', { key, code: 'ShiftLeft', keyCode, timeStamp, isComposing: true })
        )
      }
      vi.runAllTimers()

      // On main this is 1 without a re-render and 51 with one.
      expect(harness.sendInput).not.toHaveBeenCalled()
      hook.unmount()
      harness.dispose()
    })

    it('sends nothing for a bare Ctrl press mid-composition', () => {
      const harness = createHarness()
      const hook = renderHook(() => useTerminalKeyboardShortcuts(harness.deps))
      harness.startComposition()

      replay(harness, [
        {
          t: 'keydown',
          key: 'Process',
          code: 'ControlLeft',
          keyCode: 229,
          ts: 8526,
          shift: false,
          ctrl: true,
          comp: true
        },
        {
          t: 'keydown',
          key: 'Control',
          code: 'ControlLeft',
          keyCode: 17,
          ts: 8526,
          shift: false,
          ctrl: true,
          comp: true
        }
      ])

      expect(harness.sendInput).not.toHaveBeenCalled()
      hook.unmount()
      harness.dispose()
    })
  })
})
