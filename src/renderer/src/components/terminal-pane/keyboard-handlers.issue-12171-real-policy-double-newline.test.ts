// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { useTerminalKeyboardShortcuts } from './keyboard-handlers'

// NOTHING is mocked here — in particular not `./terminal-shortcut-policy`. The point of this file
// is that the recorded keydowns meet the REAL `resolveTerminalShortcutAction`, which has no
// `Process`/229 branch at all. A suite that mocks the policy can make `Process` actionable, and
// then proves nothing about production routing.

type KeyboardHandlersDeps = Parameters<typeof useTerminalKeyboardShortcuts>[0]

// Every field below is recorded, not authored. Source:
//   .tmp/ime-handoff/swarm-scratch/wave17-12171/capture-extract.json
//   SHA-256 cbaa44888b3ca59a5fd093238705cd7cf2ca0f98a43507c70cb8d901c693dd93
// Windows 10.0.26200 + Microsoft Korean (HKL 04120412), Orca 1.4.164 — inside the affected
// v1.4.163–v1.4.167 band. Real scan codes via MapVirtualKeyEx, so `code` is populated. The gesture
// is #12171's own: `d l Shift+T e k` then Space then Enter, committing `있다`. This capture records
// the modifier booleans that the earlier bundle (4e174230…) did not.
type RecordedKeydown = {
  key: string
  code: string
  keyCode: number
  isComposing: boolean
  shiftKey: boolean
}

const WINDOWS_KOREAN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Orca/1.4.164 Chrome/150.0.7871.47 Electron/43.1.0 Safari/537.36'

// All 10 keydowns of the Korean arm, in order. ONE physical Shift+T press produced the two
// IME-marked shifted keydowns at indices 2 and 4 — that pair is this row's doubling, at its cause.
const RECORDED_KOREAN_KEYDOWNS: RecordedKeydown[] = [
  { key: 'Process', code: 'KeyD', keyCode: 229, isComposing: false, shiftKey: false },
  { key: 'Process', code: 'KeyL', keyCode: 229, isComposing: true, shiftKey: false },
  { key: 'Process', code: 'ShiftLeft', keyCode: 229, isComposing: true, shiftKey: true },
  { key: 'Shift', code: 'ShiftLeft', keyCode: 16, isComposing: true, shiftKey: true },
  { key: 'Process', code: 'KeyT', keyCode: 229, isComposing: true, shiftKey: true },
  { key: 'Process', code: 'KeyE', keyCode: 229, isComposing: true, shiftKey: false },
  { key: 'Process', code: 'KeyK', keyCode: 229, isComposing: true, shiftKey: false },
  { key: 'Process', code: 'Space', keyCode: 229, isComposing: true, shiftKey: false },
  { key: ' ', code: 'Space', keyCode: 32, isComposing: false, shiftKey: false },
  { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false, shiftKey: false }
]

// Same run, same build, same pane, same host, input language switched to en-US and no IME: all 6
// keydowns of the English control arm, which recorded `compositionstart` zero times.
const RECORDED_ENGLISH_KEYDOWNS: RecordedKeydown[] = [
  { key: 'a', code: 'KeyA', keyCode: 65, isComposing: false, shiftKey: false },
  { key: 'b', code: 'KeyB', keyCode: 66, isComposing: false, shiftKey: false },
  { key: 'c', code: 'KeyC', keyCode: 67, isComposing: false, shiftKey: false },
  { key: 'd', code: 'KeyD', keyCode: 68, isComposing: false, shiftKey: false },
  { key: ' ', code: 'Space', keyCode: 32, isComposing: false, shiftKey: false },
  { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false, shiftKey: false }
]

// Native injection log of the Korean arm: `vk 0x54, scan 0x14, shift true`, once.
const RECORDED_SHIFTED_INJECTIONS = 1

const WINDOWS_SHIFT_ENTER_NEWLINE = '\x1b\r'
// Measured on a known-bad build in a different bundle,
// .tmp/ime-handoff/evidence/windows-12179-real-tui/mutation-v1/:
// ed96881b0d1b0d = 했 + ESC CR + ESC CR in ONE onData payload, from one Shift+T press.
const KNOWN_BAD_DOUBLED_PAYLOAD_HEX = 'ed96881b0d1b0d'

// Only keydowns are replayed because `useTerminalKeyboardShortcuts` installs exactly one
// window listener, for `keydown`.
function replayRecordedKeydowns(recorded: RecordedKeydown[]): string[] {
  const terminalInput: string[] = []
  const scope = document.createElement('div')
  document.body.append(scope)

  const pane = {
    id: 1,
    leafId: '00000000-0000-4000-8000-000000000001',
    terminal: {
      element: scope,
      focus: vi.fn(),
      getSelection: vi.fn(() => ''),
      input: vi.fn((data: string) => {
        terminalInput.push(data)
      })
    }
  }
  const manager = {
    getActivePane: () => pane,
    getPanes: () => [pane]
  } as unknown as PaneManager
  const transport = { getPtyId: () => 'pty-1', sendInput: vi.fn(() => true) }

  const deps = {
    tabId: 'tab-1',
    worktreeId: 'worktree-1',
    isActive: true,
    keyboardScopeRef: { current: scope },
    managerRef: { current: manager },
    paneTransportsRef: { current: new Map([[pane.id, transport as unknown as PtyTransport]]) },
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
    macOptionAsAltRef: { current: 'false' as const }
  } as unknown as KeyboardHandlersDeps

  const hook = renderHook(() => {
    useTerminalKeyboardShortcuts(deps)
  })

  for (const { key, code, keyCode, isComposing, shiftKey } of recorded) {
    const event = new KeyboardEvent('keydown', {
      key,
      code,
      shiftKey,
      bubbles: true,
      cancelable: true
    })
    // `keyCode` and `isComposing` are not settable through KeyboardEventInit in this DOM.
    Object.defineProperty(event, 'keyCode', { value: keyCode })
    Object.defineProperty(event, 'isComposing', { value: isComposing })
    scope.dispatchEvent(event)
  }

  hook.unmount()
  scope.remove()
  return terminalInput
}

describe('#12171 Windows Korean shifted jamo against the real shortcut policy', () => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      get: () => WINDOWS_KOREAN_UA
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('has a Korean fixture that can decide the pre-#12265 classifier and a control that cannot', () => {
    // Self-certifying: the discriminating field is recorded on both arms, and the control
    // genuinely lacks the value. Without this, "the English arm stayed clean" would be vacuous.
    expect(RECORDED_SHIFTED_INJECTIONS).toBe(1)
    expect(
      RECORDED_KOREAN_KEYDOWNS.filter(({ shiftKey, keyCode }) => shiftKey && keyCode === 229)
    ).toHaveLength(2)
    expect(
      RECORDED_ENGLISH_KEYDOWNS.filter(({ shiftKey, keyCode }) => shiftKey && keyCode === 229)
    ).toEqual([])
    // Two routed marked keydowns would encode as this payload's two escapes.
    expect(KNOWN_BAD_DOUBLED_PAYLOAD_HEX.split('0d')).toHaveLength(3)
  })

  it('routes a real Shift+Enter to ESC CR, so a silent arm below is silence and not a dead harness', () => {
    // Liveness control: the listener is installed, dispatched events reach it, and the real policy
    // is what answers. This is the exact byte the two arms below must not emit.
    const terminalInput = replayRecordedKeydowns([
      { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false, shiftKey: true }
    ])

    expect(terminalInput).toEqual([WINDOWS_SHIFT_ENTER_NEWLINE])
  })

  it('sends no bytes of its own across the whole recorded Korean session', () => {
    const terminalInput = replayRecordedKeydowns(RECORDED_KOREAN_KEYDOWNS)

    expect(terminalInput).toEqual([])
    expect(terminalInput.join('')).not.toContain(WINDOWS_SHIFT_ENTER_NEWLINE)
  })

  it('sends no bytes of its own across the same-run English control', () => {
    const terminalInput = replayRecordedKeydowns(RECORDED_ENGLISH_KEYDOWNS)

    expect(terminalInput).toEqual([])
    expect(terminalInput.join('')).not.toContain(WINDOWS_SHIFT_ENTER_NEWLINE)
  })
})
