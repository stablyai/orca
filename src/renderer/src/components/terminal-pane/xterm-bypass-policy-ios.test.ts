import { describe, expect, it } from 'vitest'
import {
  shouldBypassXtermForIosTextEdit,
  shouldBypassXtermKeyboardEvent
} from './xterm-bypass-policy'
import { event } from './xterm-bypass-event-fixture'

// iPadOS sends physical jamo keys without composition; native field edits must compose them.
const HANGUL_JAMO_KEYDOWN = { key: 'ㅎ', code: 'KeyG', keyCode: 71 }

describe('shouldBypassXtermForIosTextEdit', () => {
  it('claims the matching keyup and keypress so xterm cannot re-send the glyph', () => {
    for (const type of ['keyup', 'keypress']) {
      expect(shouldBypassXtermForIosTextEdit(event({ ...HANGUL_JAMO_KEYDOWN, type }), true)).toBe(
        true
      )
    }
  })

  it('leaves other non-ASCII scripts alone, since nothing downstream re-sends them', () => {
    // Only Hangul has a downstream preedit handler; claiming Cyrillic/kana would swallow them.
    for (const key of ['п', 'あ', 'é', '中']) {
      expect(shouldBypassXtermForIosTextEdit(event({ key }), true)).toBe(false)
    }
  })

  it('claims Shift-typed double consonants, which start 깨 꿈 딸 빵 쓰다 짜다', () => {
    for (const key of ['ㄲ', 'ㄸ', 'ㅃ', 'ㅆ', 'ㅉ']) {
      expect(shouldBypassXtermForIosTextEdit(event({ key, shiftKey: true }), true)).toBe(true)
      // The Shift rule already claims keydown; claim keypress too or xterm sends raw jamo.
      expect(
        shouldBypassXtermForIosTextEdit(event({ key, shiftKey: true, type: 'keypress' }), true)
      ).toBe(true)
    }
  })

  it('leaves modifier chords alone so shortcuts are not swallowed', () => {
    expect(
      shouldBypassXtermForIosTextEdit(event({ ...HANGUL_JAMO_KEYDOWN, ctrlKey: true }), true)
    ).toBe(false)
    expect(
      shouldBypassXtermForIosTextEdit(event({ ...HANGUL_JAMO_KEYDOWN, metaKey: true }), true)
    ).toBe(false)
    expect(
      shouldBypassXtermForIosTextEdit(event({ ...HANGUL_JAMO_KEYDOWN, altKey: true }), true)
    ).toBe(false)
  })

  it('leaves composing keystrokes to xterm, for iOS sources that do compose', () => {
    // On-screen and Japanese/Chinese IMEs use composition sessions already handled by xterm.
    expect(
      shouldBypassXtermForIosTextEdit(event({ ...HANGUL_JAMO_KEYDOWN, isComposing: true }), true)
    ).toBe(false)
  })
})

describe('shouldBypassXtermKeyboardEvent — iOS web', () => {
  const iosOptions = { isMac: true, isIosWeb: true, hasSelection: false }
  const macOptions = { isMac: true, hasSelection: false }

  it('bypasses a bare jamo keydown', () => {
    expect(shouldBypassXtermKeyboardEvent(event(HANGUL_JAMO_KEYDOWN), iosOptions)).toBe(true)
  })

  it('does not bypass the same key on a Mac desktop browser', () => {
    // Desktop-mode iPadOS reports Macintosh; isMac alone would also enable this on real Macs.
    expect(shouldBypassXtermKeyboardEvent(event(HANGUL_JAMO_KEYDOWN), macOptions)).toBe(false)
  })
})
