// @vitest-environment happy-dom
// Recorded on stock macOS (Chrome 151) by logging keydown/keyup/composition*/input on a
// textarea, then replayed here through the production handler and a real patched Terminal.
// Every row below is captured, not authored, including the modifier presses and releases.
//
// The two input sources answer a modifier chord in opposite ways, and the marked keydown is
// identical in both — code='ArrowLeft', keyCode=229, isComposing=true — so nothing tells them
// apart while the key is down. The release does:
//
//   - Korean 2-Set commits the syllable, emits compositionend, and the platform replays the
//     chord unmarked. isComposing is false by its keyup, and that replay resolves on its own.
//   - Japanese conversion swallows the chord outright: no compositionend, no replay, still
//     composing at keyup. Before this fix its chords produced no bytes at all.
//
// Both directions are pinned together, because the failure modes point opposite ways: Korean
// must stay at one firing per chord (a second \x1bb jumps two words), Japanese must go from
// zero to one. A change that only reads the keydown cannot satisfy both.
import { Terminal } from '@xterm/xterm'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { useTerminalKeyboardShortcuts } from './keyboard-handlers'

type RecordedRow = {
  t: string
  key?: string
  code?: string
  keyCode?: number
  isComposing?: boolean
  meta?: boolean
  alt?: boolean
  data?: string
  inputType?: string
  value?: string
}

type RecordedCase = {
  name: string
  expectCalls: string[]
  expectEmitted: string[]
  rows: RecordedRow[]
}

const CASES: RecordedCase[] = [
  {
    name: 'Korean 2-Set, Cmd+ArrowLeft',
    expectCalls: ['\x01'],
    expectEmitted: ['사', '\x01'],
    rows: [
      { t: 'keydown', key: 'ㅅ', code: 'KeyT', keyCode: 229 },
      { t: 'compositionstart', data: '' },
      { t: 'compositionupdate', data: 'ㅅ' },
      { t: 'input', data: 'ㅅ', inputType: 'insertCompositionText', value: 'ㅅ' },
      { t: 'keyup', key: 'ㅅ', code: 'KeyT', keyCode: 84, isComposing: true },
      { t: 'keydown', key: 'ㅏ', code: 'KeyK', keyCode: 229, isComposing: true },
      { t: 'compositionupdate', data: '사' },
      { t: 'input', data: '사', inputType: 'insertCompositionText', value: '사' },
      { t: 'keyup', key: 'ㅏ', code: 'KeyK', keyCode: 75, isComposing: true },
      { t: 'keydown', key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: true, meta: true },
      {
        t: 'keydown',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 229,
        isComposing: true,
        meta: true
      },
      { t: 'compositionupdate', data: '사' },
      { t: 'input', data: '사', inputType: 'insertCompositionText', value: '사' },
      { t: 'compositionend', data: '사' },
      { t: 'keyup', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, meta: true },
      { t: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, meta: true },
      { t: 'keyup', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, meta: true },
      { t: 'keyup', key: 'Meta', code: 'MetaLeft', keyCode: 91 }
    ]
  },
  {
    name: 'Korean 2-Set, Option+ArrowLeft',
    expectCalls: ['\x1bb'],
    expectEmitted: ['사', '\x1bb'],
    rows: [
      { t: 'keydown', key: 'ㅅ', code: 'KeyT', keyCode: 229 },
      { t: 'compositionstart', data: '' },
      { t: 'compositionupdate', data: 'ㅅ' },
      { t: 'input', data: 'ㅅ', inputType: 'insertCompositionText', value: 'ㅅ' },
      { t: 'keyup', key: 'ㅅ', code: 'KeyT', keyCode: 84, isComposing: true },
      { t: 'keydown', key: 'ㅏ', code: 'KeyK', keyCode: 229, isComposing: true },
      { t: 'compositionupdate', data: '사' },
      { t: 'input', data: '사', inputType: 'insertCompositionText', value: '사' },
      { t: 'keyup', key: 'ㅏ', code: 'KeyK', keyCode: 75, isComposing: true },
      { t: 'keydown', key: 'Alt', code: 'AltLeft', keyCode: 18, isComposing: true, alt: true },
      {
        t: 'keydown',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 229,
        isComposing: true,
        alt: true
      },
      { t: 'compositionupdate', data: '사' },
      { t: 'input', data: '사', inputType: 'insertCompositionText', value: '사' },
      { t: 'compositionend', data: '사' },
      { t: 'keyup', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, alt: true },
      { t: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, alt: true },
      { t: 'keyup', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, alt: true },
      { t: 'keyup', key: 'Alt', code: 'AltLeft', keyCode: 18 }
    ]
  },
  {
    name: 'Korean 2-Set, Cmd+Backspace',
    expectCalls: ['\x15'],
    expectEmitted: ['사', '\x15'],
    rows: [
      { t: 'keydown', key: 'ㅅ', code: 'KeyT', keyCode: 229 },
      { t: 'compositionstart', data: '' },
      { t: 'compositionupdate', data: 'ㅅ' },
      { t: 'input', data: 'ㅅ', inputType: 'insertCompositionText', value: 'ㅅ' },
      { t: 'keydown', key: 'ㅏ', code: 'KeyK', keyCode: 229, isComposing: true },
      { t: 'compositionupdate', data: '사' },
      { t: 'input', data: '사', inputType: 'insertCompositionText', value: '사' },
      { t: 'keyup', key: 'ㅅ', code: 'KeyT', keyCode: 84, isComposing: true },
      { t: 'keyup', key: 'ㅏ', code: 'KeyK', keyCode: 75, isComposing: true },
      { t: 'keydown', key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: true, meta: true },
      {
        t: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 229,
        isComposing: true,
        meta: true
      },
      { t: 'compositionupdate', data: '사' },
      { t: 'input', data: '사', inputType: 'insertCompositionText', value: '사' },
      { t: 'compositionend', data: '사' },
      { t: 'keyup', key: 'Backspace', code: 'Backspace', keyCode: 8, meta: true },
      { t: 'keydown', key: 'Backspace', code: 'Backspace', keyCode: 8, meta: true },
      { t: 'keyup', key: 'Backspace', code: 'Backspace', keyCode: 8, meta: true },
      { t: 'keyup', key: 'Meta', code: 'MetaLeft', keyCode: 91 }
    ]
  },
  {
    name: 'Japanese, a bare arrow and four chords across one live preedit',
    expectCalls: ['\x01', '\x1bb', '\x15', '\x1b\x7f'],
    expectEmitted: ['日本語\x01\x1bb\x15\x1b\x7f'],
    rows: [
      { t: 'keydown', key: 'n', code: 'KeyN', keyCode: 229 },
      { t: 'compositionstart', data: '' },
      { t: 'compositionupdate', data: 'n' },
      { t: 'input', data: 'n', inputType: 'insertCompositionText', value: 'n' },
      { t: 'keydown', key: 'i', code: 'KeyI', keyCode: 229, isComposing: true },
      { t: 'compositionupdate', data: 'に' },
      { t: 'input', data: 'に', inputType: 'insertCompositionText', value: 'に' },
      { t: 'keyup', key: 'n', code: 'KeyN', keyCode: 78, isComposing: true },
      { t: 'keyup', key: 'i', code: 'KeyI', keyCode: 73, isComposing: true },
      { t: 'keydown', key: 'h', code: 'KeyH', keyCode: 229, isComposing: true },
      { t: 'compositionupdate', data: 'にh' },
      { t: 'input', data: 'にh', inputType: 'insertCompositionText', value: 'にh' },
      { t: 'keydown', key: 'o', code: 'KeyO', keyCode: 229, isComposing: true },
      { t: 'compositionupdate', data: 'にほ' },
      { t: 'input', data: 'にほ', inputType: 'insertCompositionText', value: 'にほ' },
      { t: 'keyup', key: 'h', code: 'KeyH', keyCode: 72, isComposing: true },
      { t: 'keyup', key: 'o', code: 'KeyO', keyCode: 79, isComposing: true },
      { t: 'keydown', key: 'n', code: 'KeyN', keyCode: 229, isComposing: true },
      { t: 'compositionupdate', data: 'にほn' },
      { t: 'input', data: 'にほn', inputType: 'insertCompositionText', value: 'にほn' },
      { t: 'keyup', key: 'n', code: 'KeyN', keyCode: 78, isComposing: true },
      { t: 'keydown', key: 'g', code: 'KeyG', keyCode: 229, isComposing: true },
      { t: 'compositionupdate', data: 'にほんg' },
      { t: 'input', data: 'にほんg', inputType: 'insertCompositionText', value: 'にほんg' },
      { t: 'keydown', key: 'o', code: 'KeyO', keyCode: 229, isComposing: true },
      { t: 'compositionupdate', data: '日本語' },
      { t: 'input', data: '日本語', inputType: 'insertCompositionText', value: '日本語' },
      { t: 'keyup', key: 'g', code: 'KeyG', keyCode: 71, isComposing: true },
      { t: 'keyup', key: 'o', code: 'KeyO', keyCode: 79, isComposing: true },
      { t: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 229, isComposing: true },
      { t: 'compositionupdate', data: '日本語' },
      { t: 'input', data: '日本語', inputType: 'insertCompositionText', value: '日本語' },
      { t: 'keyup', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, isComposing: true },
      { t: 'keydown', key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: true, meta: true },
      {
        t: 'keydown',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 229,
        isComposing: true,
        meta: true
      },
      {
        t: 'keyup',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 37,
        isComposing: true,
        meta: true
      },
      { t: 'keyup', key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: true },
      { t: 'keydown', key: 'Alt', code: 'AltLeft', keyCode: 18, isComposing: true, alt: true },
      {
        t: 'keydown',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 229,
        isComposing: true,
        alt: true
      },
      {
        t: 'keyup',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 37,
        isComposing: true,
        alt: true
      },
      { t: 'keyup', key: 'Alt', code: 'AltLeft', keyCode: 18, isComposing: true },
      { t: 'keydown', key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: true, meta: true },
      {
        t: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 229,
        isComposing: true,
        meta: true
      },
      {
        t: 'keyup',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        isComposing: true,
        meta: true
      },
      { t: 'keyup', key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: true },
      { t: 'keydown', key: 'Alt', code: 'AltLeft', keyCode: 18, isComposing: true, alt: true },
      {
        t: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 229,
        isComposing: true,
        alt: true
      },
      { t: 'keyup', key: 'Backspace', code: 'Backspace', keyCode: 8, isComposing: true, alt: true },
      { t: 'keyup', key: 'Alt', code: 'AltLeft', keyCode: 18, isComposing: true },
      { t: 'compositionend', data: '日本語' }
    ]
  }
]

const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'

function macrotask(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

type Rig = {
  textarea: HTMLTextAreaElement
  inputCalls: string[]
  emitted: string[]
  clearPaneCalls: number
  unmount: () => void
}

function openRig(overrides: Record<string, unknown> = {}): Rig {
  const scope = document.createElement('div')
  document.body.append(scope)
  const container = document.createElement('div')
  scope.append(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea
  if (!textarea) {
    throw new Error('xterm helper textarea was not created')
  }

  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  const inputCalls: string[] = []
  const passThrough = terminal.input.bind(terminal)
  vi.spyOn(terminal, 'input').mockImplementation((data: string, wasUserInput?: boolean) => {
    inputCalls.push(data)
    passThrough(data, wasUserInput)
  })

  const transport = {
    getPtyId: () => 'pty-1',
    sendInput: vi.fn(() => true)
  } as unknown as PtyTransport
  const pane = { id: 1, leafId: '00000000-0000-4000-8000-000000000001', terminal }
  const manager = {
    getActivePane: () => pane,
    getPanes: () => [pane]
  } as unknown as PaneManager
  const deps = {
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
    macOptionAsAltRef: { current: 'false' },
    ...overrides
  } as unknown as Parameters<typeof useTerminalKeyboardShortcuts>[0]

  const hook = renderHook(() => useTerminalKeyboardShortcuts(deps))
  return {
    textarea,
    inputCalls,
    emitted,
    get clearPaneCalls() {
      return (deps.onClearPaneScrollback as ReturnType<typeof vi.fn>).mock.calls.length
    },
    unmount: () => {
      hook.unmount()
      scope.remove()
    }
  }
}

function dispatchRow(textarea: HTMLTextAreaElement, row: RecordedRow): void {
  if (row.t === 'keydown' || row.t === 'keyup') {
    const event = new KeyboardEvent(row.t, {
      key: row.key,
      code: row.code,
      metaKey: row.meta === true,
      altKey: row.alt === true,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperties(event, {
      isComposing: { value: row.isComposing === true },
      keyCode: { value: row.keyCode }
    })
    textarea.dispatchEvent(event)
    return
  }
  if (row.t.startsWith('composition')) {
    const event = new CompositionEvent(row.t, { bubbles: true })
    // happy-dom ignores CompositionEventInit.data, but Chromium supplies it.
    Object.defineProperty(event, 'data', { value: row.data ?? '' })
    textarea.dispatchEvent(event)
    return
  }
  if (row.t === 'input') {
    textarea.value = row.value ?? ''
    textarea.selectionStart = textarea.value.length
    textarea.selectionEnd = textarea.value.length
    textarea.dispatchEvent(
      new InputEvent('input', { data: row.data, inputType: row.inputType, bubbles: true })
    )
  }
}

async function replay(textarea: HTMLTextAreaElement, rows: RecordedRow[]): Promise<void> {
  for (const row of rows) {
    dispatchRow(textarea, row)
    // A full task between rows, deliberately: nothing here may depend on how fast the rows
    // arrive. Each event is decided from its own fields, so an arbitrary delay between the
    // marked press and the platform's replay must not change the outcome — spacing the rows
    // tightly would hide a regression back to a timed carry.
    await macrotask()
  }
  await macrotask()
  await macrotask()
}

describe('recorded macOS chord traces during an IME composition', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(MAC_USER_AGENT)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      const rig = openRig()
      await replay(rig.textarea, testCase.rows)

      expect(rig.inputCalls).toEqual(testCase.expectCalls)
      expect(rig.emitted).toEqual(testCase.expectEmitted)
      rig.unmount()
    }
  )

  // A chord remapped onto one of these keys resolves to a pane command rather than bytes, so
  // the swallowed-chord release has to reach every action, not just the byte path. Recovering
  // only bytes would leave a remapped Cmd+Backspace dead during a Japanese preedit.
  it('runs a remapped pane command from a swallowed release', async () => {
    const rig = openRig({ keybindings: { 'terminal.clear': ['Mod+Backspace'] } })
    await replay(rig.textarea, CASES[3].rows)

    expect(rig.clearPaneCalls).toBe(1)
    // The remap wins outright: no kill-line byte alongside it, and the other chords are
    // untouched.
    expect(rig.inputCalls).toEqual(['\x01', '\x1bb', '\x1b\x7f'])
    rig.unmount()
  })

  // The mirror of the above on the input source that does replay: the release sends nothing,
  // so the remap must run exactly once, from the replay alone.
  it('runs a remapped pane command once when the platform replays instead', async () => {
    const rig = openRig({ keybindings: { 'terminal.clear': ['Mod+Backspace'] } })
    await replay(rig.textarea, CASES[2].rows)

    expect(rig.clearPaneCalls).toBe(1)
    expect(rig.inputCalls).toEqual([])
    rig.unmount()
  })

  // The release path reads a live composition, and a rename field or the search input can hold
  // one too. Those keystrokes belong to the field, and routing them to the shell would both
  // move the wrong cursor and write bytes the user never aimed at the terminal.
  it('leaves a swallowed chord alone when the composition is in a text field', async () => {
    const rig = openRig()
    const field = document.createElement('input')
    rig.textarea.parentElement?.append(field)

    for (const t of ['keydown', 'keyup'] as const) {
      const event = new KeyboardEvent(t, {
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        metaKey: true,
        bubbles: true,
        cancelable: true
      })
      Object.defineProperties(event, {
        isComposing: { value: true },
        keyCode: { value: t === 'keydown' ? 229 : 37 }
      })
      field.dispatchEvent(event)
      await macrotask()
    }

    expect(rig.inputCalls).toEqual([])
    rig.unmount()
  })
})
