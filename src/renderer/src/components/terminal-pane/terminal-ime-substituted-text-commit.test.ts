// @vitest-environment happy-dom
// An input source that substitutes text for a printable key commits it through a
// bare `insertText` with no composition session. Drives a real Terminal wired the
// way the pane lifecycle wires it, so it covers the whole keydown -> input path.
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeNativeTextForwarder } from './terminal-ime-native-text-forwarder'
import { shouldBypassXtermKeyboardEvent } from './xterm-bypass-policy'

type SubstitutionCase = {
  name: string
  code: string
  keyCode: number
  shiftKey?: boolean
  layoutText: string
  imeText: string
}

function open(kittyKeyboardFlags = 0) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea!
  const forwarder = installTerminalImeNativeTextForwarder({
    terminalElement: terminal.element,
    isComposing: () => false,
    sendInput: (data) => terminal.input(data),
    getKittyKeyboardFlags: () => kittyKeyboardFlags
  })
  terminal.attachCustomKeyEventHandler((event) => {
    if (forwarder.claimKeyEvent(event)) {
      return false
    }
    return !shouldBypassXtermKeyboardEvent(event, {
      isMac: true,
      hasSelection: false,
      kittyKeyboardFlags
    })
  })
  const emitted: string[] = []
  terminal.onData((d) => emitted.push(d))
  return { emitted, terminal, textarea, forwarder }
}

function key(
  textarea: HTMLTextAreaElement,
  type: string,
  init: { key: string; code: string; keyCode: number; shiftKey: boolean }
): KeyboardEvent {
  const ev = new KeyboardEvent(type, {
    key: init.key,
    code: init.code,
    shiftKey: init.shiftKey,
    bubbles: true,
    cancelable: true
  })
  Object.defineProperty(ev, 'keyCode', { value: init.keyCode })
  Object.defineProperty(ev, 'charCode', { value: type === 'keypress' ? init.keyCode : 0 })
  textarea.dispatchEvent(ev)
  return ev
}

function insertText(textarea: HTMLTextAreaElement, type: string, data: string): void {
  const ev = new InputEvent(type, { bubbles: true })
  Object.defineProperty(ev, 'inputType', { value: 'insertText' })
  Object.defineProperty(ev, 'data', { value: data })
  Object.defineProperty(ev, 'composed', { value: true })
  textarea.dispatchEvent(ev)
}

function press(textarea: HTMLTextAreaElement, c: SubstitutionCase): void {
  const shiftKey = c.shiftKey === true
  const kd = key(textarea, 'keydown', {
    key: c.layoutText,
    code: c.code,
    keyCode: c.keyCode,
    shiftKey
  })
  if (!kd.defaultPrevented) {
    if (c.imeText.length === 1) {
      key(textarea, 'keypress', {
        key: c.imeText,
        code: c.code,
        keyCode: c.imeText.charCodeAt(0),
        shiftKey
      })
    }
    textarea.value = c.imeText
    textarea.setSelectionRange(c.imeText.length, c.imeText.length)
    insertText(textarea, 'beforeinput', c.imeText)
    insertText(textarea, 'input', c.imeText)
  }
  key(textarea, 'keyup', { key: c.layoutText, code: c.code, keyCode: c.keyCode, shiftKey })
}

function type(cases: SubstitutionCase[], kitty = 0): string {
  const { emitted, terminal, textarea, forwarder } = open(kitty)
  for (const c of cases) {
    press(textarea, c)
  }
  forwarder.dispose()
  terminal.dispose()
  return emitted.join('')
}

const COMMA: SubstitutionCase = {
  name: 'comma',
  code: 'Comma',
  keyCode: 188,
  layoutText: ',',
  imeText: '，'
}
const PERIOD: SubstitutionCase = {
  name: 'period',
  code: 'Period',
  keyCode: 190,
  layoutText: '.',
  imeText: '。'
}
const QUESTION: SubstitutionCase = {
  name: 'question',
  code: 'Slash',
  keyCode: 191,
  shiftKey: true,
  layoutText: '?',
  imeText: '？'
}
const BACKSLASH: SubstitutionCase = {
  name: 'ideographic comma',
  code: 'Backslash',
  keyCode: 220,
  layoutText: '\\',
  imeText: '、'
}
const EM_DASH: SubstitutionCase = {
  name: 'em dash pair',
  code: 'Minus',
  keyCode: 189,
  shiftKey: true,
  layoutText: '_',
  imeText: '——'
}
const FULLWIDTH_ONE: SubstitutionCase = {
  name: 'full-width one',
  code: 'Digit1',
  keyCode: 49,
  layoutText: '1',
  imeText: '１'
}
const TELEX_A: SubstitutionCase = {
  name: 'telex a-acute',
  code: 'KeyS',
  keyCode: 83,
  layoutText: 's',
  imeText: 'á'
}

describe('input-source text substitution reaches the terminal', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('sends the substituted sentence tail, not the raw layout characters', () => {
    expect(type([COMMA, PERIOD, PERIOD])).toBe('，。。')
  })
  it('sends a shifted substitution', () => {
    expect(type([QUESTION])).toBe('？')
  })
  it('sends the backslash-position substitution (#10896)', () => {
    expect(type([BACKSLASH])).toBe('、')
  })
  it('sends a multi-code-unit substitution from one press', () => {
    expect(type([EM_DASH])).toBe('——')
  })
  it('sends a full-width digit substitution', () => {
    expect(type([FULLWIDTH_ONE])).toBe('１')
  })
  it('sends a letter substitution', () => {
    expect(type([TELEX_A])).toBe('á')
  })
  it('sends the substitution with kitty disambiguate reporting negotiated', () => {
    expect(type([COMMA], 1)).toBe('，')
  })

  // The gate is bit 3 alone. Every other flag leaves printable keys as text, so the substituted
  // character must still reach the pane; gating on "kitty active" instead would strip the
  // substitution from every pane that negotiates anything at all.
  describe.each([
    ['none', 0],
    ['disambiguate', 1],
    ['alternate keys', 4],
    ['disambiguate + alternate keys', 5],
    // Bit 4 asks for associated text, which only decorates a report bit 3 would already have
    // produced — on its own it does not turn a printable key into one.
    ['associated text', 16]
  ])('with kitty flags %s (%d) negotiated', (_name, flags) => {
    it('sends the substituted character raw', () => {
      expect(type([COMMA], flags)).toBe('，')
    })
  })

  // Bit 1 (`report_event_types`) is orthogonal to bit 3: the press stays raw substituted text,
  // but the app asked to be told when the key came back up, and the forwarder owns that keyup.
  describe.each([
    ['event types', 2],
    ['disambiguate + event types + alternate keys', 7]
  ])('with kitty flags %s (%d) negotiated', (_name, flags) => {
    it('sends the substituted character raw followed by one CSI-u release', () => {
      expect(type([COMMA], flags)).toBe('，\x1b[44;1:3u')
    })
  })

  // Bit 3 is `report_all_keys_as_escape_codes`: the app asked for every printable key as a CSI-u
  // report, so committing raw UTF-8 hands it a byte stream it declined. Re-encode the press that
  // produced the commit. This is not CJK-specific — it is every printable key in such a pane.
  describe.each([
    ['all keys as escape codes', 8],
    ['all keys + disambiguate', 9]
  ])('with kitty flags %s (%d) negotiated', (_name, flags) => {
    it('sends a CSI-u report for the physical key instead of the substituted character', () => {
      // `,` is the physical Comma key; U+002C is 44. The committed `，` is deliberately absent —
      // see terminal-ime-kitty-commit-encoding.ts on why bit 3 without an encoder change cannot
      // carry it.
      expect(type([COMMA], flags)).toBe('\x1b[44u')
    })
  })

  it('pairs the CSI-u press with exactly one release when event types are also negotiated', () => {
    expect(type([COMMA], 15)).toBe('\x1b[44u\x1b[44;1:3u')
  })

  it('reports the physical key as the associated text under bit 3 + bit 4, not the substitution', () => {
    // Pins the limit named in terminal-ime-kitty-commit-encoding.ts: bit 4 is where the committed
    // glyph U+FF0C (65292) would ride, and 44 shows up in that slot instead. Closing that needs the
    // encoder to take the text separately from the key, so it is not reachable by widening a gate.
    expect(type([COMMA], 24)).toBe('\x1b[44;;44u')
  })

  it('encodes a shifted substitution as a CSI-u report with the shift modifier', () => {
    // Shift is the one modifier the claim keeps eligible, so it has to survive the encoding.
    // 63 is `?`, not 47 for the unshifted `/`: xterm's encoder only unwinds a shifted key to its
    // base through `Digit*`/`Key*` codes, and this press carries `Slash`. Pinned as-is — that is
    // the shared encoder's behaviour for shifted punctuation on every path, not something the
    // commit path introduces.
    expect(type([QUESTION], 8)).toBe('\x1b[63;2u')
  })

  it('encodes a multi-character substitution as one report, not one per character', () => {
    // One press produced `——`; bit 3 reports keys, and this was a single key.
    expect(type([EM_DASH], 8)).toBe('\x1b[95;2u')
  })
})
