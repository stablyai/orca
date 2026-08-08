// @vitest-environment happy-dom
/**
 * Issue #13033 — on macOS with Korean 2-Set active, the physical Cmd+C chord is reported as
 * `{ key: "ㅊ", code: "KeyC", metaKey: true }`. Every `key.toLowerCase() === 'c'` match misses
 * it, the copy shortcut is not recognised, and xterm encodes the chord as PTY input — the
 * reporter observed `ESC[12618;9u` and a viewport that jumps to the bottom, because user input
 * scrolls the terminal.
 *
 * The event shapes below are the reporter's, from #13033 (Orca 1.4.158, macOS 26.5.2, Apple
 * Silicon, `com.apple.inputmethod.Korean.2SetKorean`). The non-Korean rows are the same physical
 * key under other input sources that also rewrite `key`.
 *
 * This is the same key-vs-code confusion that owned #12171, where `Shift+T` typing ㅆ was read as
 * Enter for want of a `code` guard — so the fix is the same shape: trust `code` when it is there.
 */
import { describe, expect, it } from 'vitest'

import { isLatinShortcutKey } from './ime-latin-shortcut-key'

/** Physical Cmd+C as reported under each input source. `code` is stable; `key` is not. */
const CMD_C_BY_INPUT_SOURCE = [
  { key: 'c', label: 'ABC (Latin)' },
  { key: 'ㅊ', label: 'Korean 2-Set — the reported shape' },
  { key: 'そ', label: 'Japanese kana' },
  { key: 'ись', label: 'a multi-character rewrite' }
] as const

describe('isLatinShortcutKey', () => {
  it('matches the physical key whatever the IME rewrote key to', () => {
    for (const { key, label } of CMD_C_BY_INPUT_SOURCE) {
      expect(isLatinShortcutKey({ key, code: 'KeyC' }, 'c'), label).toBe(true)
    }
  })

  it('ordinary negative: a different physical key never matches', () => {
    // The Korean jamo for the C key must not make the V key match, or the fix would
    // trade a missed shortcut for a fired-wrong one.
    expect(isLatinShortcutKey({ key: 'ㅊ', code: 'KeyV' }, 'c')).toBe(false)
    expect(isLatinShortcutKey({ key: 'c', code: 'KeyV' }, 'c')).toBe(false)
    expect(isLatinShortcutKey({ key: 'v', code: 'KeyV' }, 'c')).toBe(false)
  })

  it('falls back to key when the event carries no code', () => {
    // Chromium omits `code` on synthetic and some keypress events.
    expect(isLatinShortcutKey({ key: 'c' }, 'c')).toBe(true)
    expect(isLatinShortcutKey({ key: 'C' }, 'c')).toBe(true)
    expect(isLatinShortcutKey({ key: '', code: '' }, 'c')).toBe(false)
  })

  it('falls back to keyCode, which keeps its US value when key is rewritten', () => {
    expect(isLatinShortcutKey({ key: 'ㅊ', keyCode: 67 }, 'c')).toBe(true)
    expect(isLatinShortcutKey({ key: 'ㅊ', keyCode: 86 }, 'c')).toBe(false)
  })

  it('treats a blank code as absent rather than as a non-match', () => {
    // A whitespace-only code must not be trusted over the logical key.
    expect(isLatinShortcutKey({ key: 'c', code: '   ' }, 'c')).toBe(true)
  })
})
