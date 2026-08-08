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
//
// Two things this rig cannot speak for. The userAgent mock below only reaches Orca's own check;
// xterm reads `navigator.platform` once at module load and does not see a Mac here, which is
// harmless while Orca intercepts every replayed row but would diverge for anything it stops
// intercepting. And `expectEmitted` groups bytes the way a full task between rows produces —
// real input arrives in one burst and may group differently. Read `expectCalls` for the
// contract; `expectEmitted` is there to show ordering, not framing.
//
// IN_APP_TRACE_CASES is a second, independent recording taken inside the app rather than on a
// bare page (provenance and per-case notes in keyboard-handlers.issue-12871-in-app-chord-traces
// .ts). It is replayed through the same rig below. The two surfaces captured different subsets
// of the same gestures, so each case there states which half of the contract it can speak for.
import { Terminal } from '@xterm/xterm'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { useTerminalKeyboardShortcuts } from './keyboard-handlers'
import { IN_APP_TRACE_CASES } from './keyboard-handlers.issue-12871-in-app-chord-traces'

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
  terminal: Terminal
  searchSelections: string[]
  closePaneCalls: number[]
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
    terminal,
    inputCalls,
    emitted,
    get closePaneCalls() {
      return (deps.onRequestClosePane as ReturnType<typeof vi.fn>).mock.calls.map(
        ([id]) => id as number
      )
    },
    get searchSelections() {
      return (deps.onSearchSelectedText as ReturnType<typeof vi.fn>).mock.calls.map(
        ([text]) => text as string
      )
    },
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

const JAPANESE_CASE = 'Japanese, a bare arrow and four chords across one live preedit'

// By name, not by index: each test below needs a particular gesture, and inserting a case
// would otherwise silently repoint them at the wrong trace while still passing.
function caseNamed(name: string): RecordedCase {
  const found = CASES.find((testCase) => testCase.name === name)
  if (!found) {
    throw new Error(`recorded case not found: ${name}`)
  }
  return found
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

  it.each([...CASES, ...IN_APP_TRACE_CASES].map((testCase) => [testCase.name, testCase] as const))(
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
    await replay(rig.textarea, caseNamed(JAPANESE_CASE).rows)

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
    await replay(rig.textarea, caseNamed('Korean 2-Set, Cmd+Backspace').rows)

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

// Constructed, not recorded. Both cases below need a shape the two captures happen not to
// contain, and the file above is kept to captured rows only so its fidelity claim stays true.
describe('constructed shapes the macOS captures do not contain', () => {
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

  // The decision is the release's alone. Pinned directly rather than left to be inferred from
  // the call counts above, because `resolveTerminalKeyboardShortcutAction` does resolve a
  // composing exempt chord — it is the pane that declines to act on it until the key comes up.
  it('does nothing while the chord is still held down', async () => {
    const rig = openRig()
    const japanese = caseNamed(JAPANESE_CASE)
    const throughFirstChordPress = japanese.rows.slice(
      0,
      japanese.rows.findIndex(
        (row) => row.keyCode === 229 && row.code === 'ArrowLeft' && row.meta
      ) + 1
    )
    await replay(rig.textarea, throughFirstChordPress)

    expect(rig.inputCalls).toEqual([])
    rig.unmount()
  })

  // The keydown path lets an empty floating panel claim a remapped tab.close before the pane
  // does. Without the same order on the release, one chord closes a panel when pressed outside
  // a composition and closes the pane when pressed inside one.
  it('lets an empty floating panel claim a remapped tab.close from a release', async () => {
    const panel = document.createElement('div')
    panel.setAttribute('data-floating-terminal-panel', '')
    panel.setAttribute('aria-hidden', 'false')
    const emptyState = document.createElement('div')
    emptyState.setAttribute('data-floating-terminal-empty-state', '')
    panel.append(emptyState)
    document.body.append(panel)

    const rig = openRig({ keybindings: { 'tab.close': ['Mod+Backspace'] } })
    await replay(rig.textarea, caseNamed(JAPANESE_CASE).rows)

    expect(rig.closePaneCalls).toEqual([])
    // The other three chords are untouched; only the panel's chord is withheld.
    expect(rig.inputCalls).toEqual(['\x01', '\x1bb', '\x1b\x7f'])
    rig.unmount()
  })

  // The keydown path runs the file-search chord ahead of the shortcut policy, so a release
  // that went straight to the policy would make the same remap mean two different things
  // depending on whether a composition happened to be live.
  it('runs the file-search chord from a release, ahead of the byte fallback', async () => {
    const rig = openRig({ keybindings: { 'sidebar.search.toggle': ['Mod+Backspace'] } })
    vi.spyOn(rig.terminal, 'getSelection').mockReturnValue('src/main.ts')
    await replay(rig.textarea, caseNamed(JAPANESE_CASE).rows)

    expect(rig.searchSelections).toEqual(['src/main.ts'])
    // The kill-line byte the built-in binding would have sent is not sent alongside it.
    expect(rig.inputCalls).toEqual(['\x01', '\x1bb', '\x1b\x7f'])
    rig.unmount()
  })

  // The composition can live in a rename field or the search input, and that field can unmount
  // while the key is still down — the release then arrives with the terminal as its target and
  // walks straight past the editable guard. Refusing to arm from such a press closes that,
  // where refusing at the release cannot.
  it('never arms from a press aimed at a text field, even if the field then unmounts', async () => {
    const rig = openRig()
    const field = document.createElement('input')
    rig.textarea.parentElement?.append(field)

    const press = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      altKey: true,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperties(press, { isComposing: { value: true }, keyCode: { value: 229 } })
    field.dispatchEvent(press)
    await macrotask()
    field.remove()

    await replay(rig.textarea, [
      { t: 'keyup', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, isComposing: true, alt: true }
    ])

    expect(rig.inputCalls).toEqual([])
    rig.unmount()
  })

  // The action has already run by the time the release is consumed, so there is nothing left to
  // race — and cutting a keyup off at window capture keeps it from ever reaching xterm, whose
  // own keyup handler clears the flags its input path reads.
  it('leaves the keyup itself to finish propagating', async () => {
    const rig = openRig()
    const seen: string[] = []
    const listener = (event: KeyboardEvent): void => {
      seen.push(event.type)
    }
    rig.textarea.addEventListener('keyup', listener)
    await replay(rig.textarea, caseNamed(JAPANESE_CASE).rows)
    rig.textarea.removeEventListener('keyup', listener)

    expect(rig.inputCalls).toEqual(['\x01', '\x1bb', '\x15', '\x1b\x7f'])
    // Four chord releases plus the letters and modifiers around them: every one arrives.
    expect(seen.length).toBe(
      caseNamed(JAPANESE_CASE).rows.filter((row) => row.t === 'keyup').length
    )
    rig.unmount()
  })

  // Three separate ways a carry can be left with no release of its own to spend it, each with
  // its own escape. Split apart deliberately: one test covering all three passes as long as any
  // one of them works, which pins none of them.
  const ARMED_ALT_ARROW: RecordedRow[] = [
    { t: 'compositionstart', data: '' },
    { t: 'keydown', key: 'Alt', code: 'AltLeft', keyCode: 18, isComposing: true, alt: true },
    {
      t: 'keydown',
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      keyCode: 229,
      isComposing: true,
      alt: true
    }
  ]

  // The user pressed the key again for its own sake. Whatever the last press carried is over,
  // even though this one is IME-owned too and claims no carry of its own.
  it('lets a later press of the same key supersede the carry', async () => {
    const rig = openRig()
    await replay(rig.textarea, [
      ...ARMED_ALT_ARROW,
      { t: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 229, isComposing: true },
      { t: 'keyup', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, isComposing: true }
    ])

    expect(rig.inputCalls).toEqual([])
    rig.unmount()
  })

  // Cmd+Tab or Spotlight takes the release with it. If the window gets the keyup back later,
  // the chord it belonged to is long gone.
  it('drops the carry when focus leaves the window', async () => {
    const rig = openRig()
    await replay(rig.textarea, ARMED_ALT_ARROW)
    window.dispatchEvent(new Event('blur'))
    await replay(rig.textarea, [
      { t: 'keyup', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, isComposing: true, alt: true }
    ])

    expect(rig.inputCalls).toEqual([])
    rig.unmount()
  })

  // The release arrived but a guard turned it away. The key is still up, so the press is still
  // over — a carry that survives a refused release answers for whatever comes next instead.
  it('spends the carry on a release a guard refuses', async () => {
    const rig = openRig()
    const field = document.createElement('input')
    rig.textarea.parentElement?.append(field)
    await replay(rig.textarea, ARMED_ALT_ARROW)

    const refused = new KeyboardEvent('keyup', {
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      altKey: true,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperties(refused, { isComposing: { value: true }, keyCode: { value: 37 } })
    field.dispatchEvent(refused)
    await macrotask()

    await replay(rig.textarea, [
      { t: 'keyup', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, isComposing: true, alt: true }
    ])

    expect(rig.inputCalls).toEqual([])
    rig.unmount()
  })

  // A KeyboardEvent's modifier flags describe the moment it fired, so letting Cmd up before
  // the arrow leaves the arrow's keyup with metaKey: false. Reading the release's own flags
  // drops the chord outright, which is the bug this whole change exists to fix.
  it('sends the chord when the modifier is released before the key', async () => {
    const rig = openRig()
    const japanese = caseNamed(JAPANESE_CASE)
    const beforeFirstChord = japanese.rows.slice(
      0,
      japanese.rows.findIndex((row) => row.t === 'keydown' && row.code === 'MetaLeft')
    )
    await replay(rig.textarea, [
      ...beforeFirstChord,
      { t: 'keydown', key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: true, meta: true },
      {
        t: 'keydown',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 229,
        isComposing: true,
        meta: true
      },
      { t: 'keyup', key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: true },
      { t: 'keyup', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, isComposing: true }
    ])

    expect(rig.inputCalls).toEqual(['\x01'])
    rig.unmount()
  })

  // The mirror hazard: the key went down with no composition in sight, so it already resolved
  // from its own keydown. A composition starting while it is held must not make the release
  // send it a second time — for Option+Left that is two words instead of one.
  it('does not send twice when a composition starts while the key is held', async () => {
    const rig = openRig()
    await replay(rig.textarea, [
      { t: 'keydown', key: 'Alt', code: 'AltLeft', keyCode: 18, alt: true },
      { t: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, alt: true },
      { t: 'compositionstart', data: '' },
      { t: 'keyup', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, isComposing: true, alt: true }
    ])

    expect(rig.inputCalls).toEqual(['\x1bb'])
    rig.unmount()
  })

  // Windows reports an IME-consumed key as `key: 'Process'` (#12171), which normalizes to no
  // token at all, so the keybinding lookup has to run on the physical `code` instead. macOS
  // leaves `key` alone, so no capture reaches that substitution — without this the branch is
  // only ever exercised by plain-object fixtures, never by a real event through the handler.
  it('honours a remap when the input source has rewritten key to Process', async () => {
    const rig = openRig({ keybindings: { 'terminal.clear': ['Mod+Backspace'] } })
    const japanese = caseNamed(JAPANESE_CASE)
    const rows = japanese.rows.map((row) =>
      row.code === 'Backspace' ? { ...row, key: 'Process' } : row
    )
    await replay(rig.textarea, rows)

    // Without the physical-code substitution this falls through to the built-in kill-line
    // byte: the wrong action, silently, for anyone who remapped the chord.
    expect(rig.clearPaneCalls).toBe(1)
    expect(rig.inputCalls).toEqual(['\x01', '\x1bb', '\x1b\x7f'])
    rig.unmount()
  })

  // Escape during a preedit ends the composition with an empty commit. xterm flushes whatever
  // the chord queued at that point, so this pins where those bytes go rather than leaving it
  // to be discovered in a shell.
  it('still delivers a chord when the composition is cancelled instead of committed', async () => {
    const rig = openRig()
    const japanese = caseNamed(JAPANESE_CASE)
    const upToFirstChord = japanese.rows.slice(
      0,
      japanese.rows.findIndex((row) => row.t === 'keyup' && row.code === 'MetaLeft') + 1
    )
    // Escape clears the preedit out of the helper textarea before the composition ends; xterm
    // reads the commit from that textarea, so omitting this row would commit 日本語 after all.
    await replay(rig.textarea, [
      ...upToFirstChord,
      { t: 'input', inputType: 'deleteCompositionText', value: '' },
      { t: 'compositionend', data: '' }
    ])

    // The chord was aimed at the shell's line, not at the preedit, so cancelling the text does
    // not retract it. Only the composed characters are dropped.
    expect(rig.inputCalls).toEqual(['\x01'])
    expect(rig.emitted).toEqual(['\x01'])
    rig.unmount()
  })
})
