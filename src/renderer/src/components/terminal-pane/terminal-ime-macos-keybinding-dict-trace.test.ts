// @vitest-environment happy-dom
// #11170: a ~/Library/KeyBindings/DefaultKeyBinding.dict remap is honoured everywhere on macOS
// except the terminal, which sends the raw layout character to the PTY.
//
// The OS applies the substitution inside the AppKit text input path, so it exists only on
// keypress.charCode and on the input event's `data` — keydown.key still carries the layout
// character. Nothing here needs to parse the dict: Chromium's renderer is already the text
// system's client and has applied it by the time `input` fires. The bug was that the keydown
// manufactured a byte and preventDefault'd, tearing the text pipeline down before the
// substitution could arrive.
//
// This pins the behaviour across a design change rather than introducing it. The reported build
// sent the raw character; a later punctuation table happened to list that one character, which
// closed the issue by enumeration. Replacing the table with a structural claim removes the entry,
// so without a test the fix could regress silently on a change that never mentions #11170.
// Both designs fail this file when their respective claim is removed.
//
// The harness supplies no input-source classification, which models a source the older design did
// not recognise — including the window before its async probe resolves. That is the condition
// under which the second layout arm separates the two designs: with the source recognised the
// older one claimed all ASCII punctuation and covered it too, so the gap was real but conditional.
// The structural claim has no such condition, which is the point.
//
// Replays the recorded event shape from the issue rather than an authored one, and pairs it with
// the same physical key carrying no substitution — a fix that rewrote the Backquote position
// unconditionally would pass the positive case and be badly wrong.
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import trace from './__fixtures__/macos-keybinding-dict-backquote-trace.json'
import { installTerminalImeNativeTextForwarder } from './terminal-ime-native-text-forwarder'
import { shouldBypassXtermKeyboardEvent } from './xterm-bypass-policy'

type RecordedEvent = {
  type: string
  key?: string
  code?: string
  keyCode?: number
  charCode?: number
  data?: string
  inputType?: string
  isComposing?: boolean
  value?: string
}

type RecordedCase = {
  name: string
  expectedPty: string
  dom: RecordedEvent[]
}

const CASES = trace.cases as RecordedCase[]

function caseNamed(name: string): RecordedCase {
  const found = CASES.find((entry) => entry.name === name)
  if (!found) {
    throw new Error(`fixture case '${name}' missing`)
  }
  return found
}

function buildEvent(recorded: RecordedEvent): Event {
  if (recorded.type === 'input' || recorded.type === 'beforeinput') {
    const input = new InputEvent(recorded.type, {
      isComposing: recorded.isComposing,
      bubbles: true
    })
    // happy-dom drops these from InputEventInit; Chromium supplies them.
    Object.defineProperty(input, 'inputType', { value: recorded.inputType ?? '' })
    Object.defineProperty(input, 'data', { value: recorded.data ?? null })
    Object.defineProperty(input, 'composed', { value: true })
    return input
  }
  const keyboard = new KeyboardEvent(recorded.type, {
    key: recorded.key,
    code: recorded.code,
    isComposing: recorded.isComposing,
    bubbles: true,
    cancelable: true
  })
  Object.defineProperty(keyboard, 'keyCode', { value: recorded.keyCode ?? 0 })
  Object.defineProperty(keyboard, 'charCode', { value: recorded.charCode ?? 0 })
  return keyboard
}

/** Mirrors the handler order in use-terminal-pane-lifecycle.ts: the native-text claim,
 *  then the bypass policy. */
function open() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const forwarder = installTerminalImeNativeTextForwarder({
    terminalElement: terminal.element,
    isComposing: () => false,
    sendInput: (data) => terminal.input(data)
  })
  terminal.attachCustomKeyEventHandler((event) => {
    if (forwarder.claimKeyEvent(event)) {
      return false
    }
    return !shouldBypassXtermKeyboardEvent(event, {
      isMac: true,
      hasSelection: false,
      kittyKeyboardFlags: 0
    })
  })
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { emitted, terminal, forwarder }
}

/** Replays recorded cases in order and returns the bytes that reached the PTY. */
function replay(names: string[]): string {
  const { emitted, terminal, forwarder } = open()
  const textarea = terminal.textarea!
  for (const name of names) {
    for (const recorded of caseNamed(name).dom) {
      const event = buildEvent(recorded)
      // Why: the recorded keydown is what a real browser only emits the rest of the sequence
      // after, so a claim that preventDefaults must truncate the replay exactly as Chromium would.
      if (recorded.type !== 'keydown' && recorded.type !== 'keyup') {
        textarea.value = recorded.value ?? ''
        textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      }
      textarea.dispatchEvent(event)
      if (recorded.type === 'keydown' && event.defaultPrevented) {
        break
      }
    }
  }
  forwarder.dispose()
  terminal.dispose()
  return emitted.join('')
}

describe('#11170 — a DefaultKeyBinding.dict remap reaches the PTY', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('sends the remapped character, not the raw layout character', () => {
    expect(replay(['remapped'])).toBe(caseNamed('remapped').expectedPty)
  })

  // Same physical key, same dict entry, on the Korean layout that puts an asterisk there instead.
  // This is the arm that discriminates without a mutation: the older design honoured the
  // substitution by listing characters, and listed the reported one but not this one.
  it('sends the remapped character on the other Korean layout too', () => {
    const remapped = caseNamed('remapped-other-korean-layout')
    expect(replay([remapped.name])).toBe(remapped.expectedPty)
  })

  // The paired negative. Same physical key, same keydown.key, no substitution in play.
  it('still sends the layout character when nothing remaps the key', () => {
    expect(replay(['no-remap-korean'])).toBe(caseNamed('no-remap-korean').expectedPty)
  })

  it('still sends the plain backquote under an ASCII layout', () => {
    expect(replay(['no-remap-ascii'])).toBe(caseNamed('no-remap-ascii').expectedPty)
  })

  it('leaves the next keystroke untouched', () => {
    expect(replay(['remapped', 'remapped-neighbour-key'])).toBe('`a')
  })

  // The dict's "~₩" rule (Option+the key -> the layout character) is out of scope: Option chords
  // are deliberately excluded from the claim, and the option-as-alt setting consumes Option first.
  it('does not claim the Option chord the dict also binds', () => {
    const { emitted, terminal, forwarder } = open()
    const textarea = terminal.textarea!
    const chord = new KeyboardEvent('keydown', {
      key: '₩',
      code: 'Backquote',
      altKey: true,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperty(chord, 'keyCode', { value: 192 })
    textarea.dispatchEvent(chord)
    forwarder.dispose()
    terminal.dispose()
    expect(emitted.join('')).not.toBe('')
  })
})
