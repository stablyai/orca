import { describe, expect, it } from 'vitest'
import {
  isNonLatinControlChordKeyup,
  resolveNonLatinControlChordInput,
  type NonLatinControlChordEvent
} from './terminal-non-latin-control-chord'

function event(overrides: Partial<NonLatinControlChordEvent>): NonLatinControlChordEvent {
  return {
    type: 'keydown',
    key: 'ㅁ',
    code: 'KeyA',
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides
  }
}

describe('resolveNonLatinControlChordInput', () => {
  // UCKeyTranslate maps physical A/U/C to the same control bytes on Hangul, Russian, Greek and ABC.
  it.each([
    ['Korean 2-Set', 'ㅁ', 'KeyA', '\x01'],
    ['Korean 2-Set', 'ㅕ', 'KeyU', '\x15'],
    ['Russian', 'ф', 'KeyA', '\x01'],
    ['Russian', 'г', 'KeyU', '\x15'],
    ['Greek', 'α', 'KeyA', '\x01'],
    ['Greek', 'θ', 'KeyU', '\x15'],
    ['Hangul syllable', '가', 'KeyD', '\x04']
  ])('%s: Ctrl+%s on %s sends %j', (_layout, key, code, expected) => {
    expect(resolveNonLatinControlChordInput(event({ key, code }))).toBe(expected)
  })

  it('covers the whole letter range, not just the reported keys', () => {
    for (let index = 0; index < 26; index++) {
      const letter = String.fromCharCode(0x41 + index)
      if (letter === 'C') {
        continue
      }
      expect(resolveNonLatinControlChordInput(event({ code: `Key${letter}` }))).toBe(
        String.fromCharCode(index + 1)
      )
    }
  })

  // Ctrl+C belongs to interrupt policy, which yields to selection copy off macOS; claiming here would wrongly send ETX.
  it('leaves Ctrl+C to the interrupt policy', () => {
    expect(resolveNonLatinControlChordInput(event({ key: 'ㅊ', code: 'KeyC' }))).toBeNull()
  })

  // An ASCII logical key is authoritative: a Dvorak remap really did move the letter.
  it('leaves an ASCII logical key to xterm', () => {
    expect(resolveNonLatinControlChordInput(event({ key: 'a', code: 'KeyA' }))).toBeNull()
    expect(resolveNonLatinControlChordInput(event({ key: 'j', code: 'KeyC' }))).toBeNull()
  })

  it('ignores chords that are not a plain Ctrl press', () => {
    expect(resolveNonLatinControlChordInput(event({ ctrlKey: false }))).toBeNull()
    expect(resolveNonLatinControlChordInput(event({ altKey: true }))).toBeNull()
    expect(resolveNonLatinControlChordInput(event({ metaKey: true }))).toBeNull()
    // Ctrl+Shift has its own encoding; rewriting it would change a correct kitty report.
    expect(resolveNonLatinControlChordInput(event({ shiftKey: true }))).toBeNull()
    expect(resolveNonLatinControlChordInput(event({ type: 'keyup' }))).toBeNull()
  })

  it('ignores physical keys that are not letters', () => {
    // Digits and punctuation stay ASCII in `key` on these layouts, so xterm still sees them.
    expect(resolveNonLatinControlChordInput(event({ key: '2', code: 'Digit2' }))).toBeNull()
    expect(resolveNonLatinControlChordInput(event({ code: 'BracketLeft' }))).toBeNull()
    expect(resolveNonLatinControlChordInput(event({ code: undefined }))).toBeNull()
  })

  it('ignores named and empty keys', () => {
    expect(resolveNonLatinControlChordInput(event({ key: 'Enter' }))).toBeNull()
    // 'Process' is what some input sources report while an IME owns the key.
    expect(resolveNonLatinControlChordInput(event({ key: 'Process' }))).toBeNull()
    expect(resolveNonLatinControlChordInput(event({ key: '' }))).toBeNull()
  })

  // Use a structural non-ASCII rule, including astral codepoints, rather than a script allowlist.
  it('treats any single non-ASCII codepoint uniformly', () => {
    expect(resolveNonLatinControlChordInput(event({ key: '😀' }))).toBe('\x01')
    expect(resolveNonLatinControlChordInput(event({ key: 'ア' }))).toBe('\x01')
    expect(resolveNonLatinControlChordInput(event({ key: 'א' }))).toBe('\x01')
  })
})

describe('isNonLatinControlChordKeyup', () => {
  it('matches the claimed press by physical key', () => {
    expect(isNonLatinControlChordKeyup(event({ type: 'keyup' }), 'KeyA')).toBe(true)
    // Ctrl may already be up by the time the letter is released.
    expect(isNonLatinControlChordKeyup(event({ type: 'keyup', ctrlKey: false }), 'KeyA')).toBe(true)
  })

  it('does not match a different key or an unclaimed press', () => {
    expect(isNonLatinControlChordKeyup(event({ type: 'keyup', code: 'KeyB' }), 'KeyA')).toBe(false)
    expect(isNonLatinControlChordKeyup(event({ type: 'keyup' }), null)).toBe(false)
    expect(isNonLatinControlChordKeyup(event({ type: 'keydown' }), 'KeyA')).toBe(false)
  })
})
