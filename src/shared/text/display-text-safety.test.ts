import { describe, expect, it } from 'vitest'
import { isSafeDisplayText, stripUnsafeDisplayCharacters } from './display-text-safety'

describe('display text safety', () => {
  it('keeps safe text and joiners while removing reordering and hidden characters', () => {
    const joined =
      '\u{1f468}\u200d\u{1f469}\u200d\u{1f467} \u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645'
    expect(stripUnsafeDisplayCharacters('plain text')).toBe('plain text')
    expect(stripUnsafeDisplayCharacters(joined)).toBe(joined)
    expect(stripUnsafeDisplayCharacters('a\u202eb\u0007c\ud800d\u2028e\u{e0041}f')).toBe('abcdef')
  })

  it('checks whole strings with the same pattern', () => {
    expect(isSafeDisplayText('\u{1f468}\u200d\u{1f469} \u0645\u06cc\u200c\u062e')).toBe(true)
    expect(isSafeDisplayText('docs/readme\u202e.md')).toBe(false)
    expect(isSafeDisplayText('a\ud800b')).toBe(false)
  })
})
