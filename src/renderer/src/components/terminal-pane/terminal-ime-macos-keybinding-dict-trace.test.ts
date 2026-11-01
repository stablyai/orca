// @vitest-environment happy-dom
/** DefaultKeyBinding.dict substitutions arrive in keypress/input, while keydown retains the layout character (#11170). Replay recorded substitutions and same-key negatives without source classification so claims cannot depend on punctuation lists or async source probes. */
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
      // Truncate replay after preventDefault as Chromium does; later events cannot follow a cancelled keydown.
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

  // The Korean-layout asterisk exercises the same substitution without relying on the old punctuation list.
  it('sends the remapped character on the other Korean layout too', () => {
    const remapped = caseNamed('remapped-other-korean-layout')
    expect(replay([remapped.name])).toBe(remapped.expectedPty)
  })

  it('still sends the layout character when nothing remaps the key', () => {
    expect(replay(['no-remap-korean'])).toBe(caseNamed('no-remap-korean').expectedPty)
  })

  it('still sends the plain backquote under an ASCII layout', () => {
    expect(replay(['no-remap-ascii'])).toBe(caseNamed('no-remap-ascii').expectedPty)
  })

  it('leaves the next keystroke untouched', () => {
    expect(replay(['remapped', 'remapped-neighbour-key'])).toBe('`a')
  })

  // Option chords stay outside this claim; option-as-alt consumes them first.
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
