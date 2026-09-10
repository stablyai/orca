import { describe, expect, it } from 'vitest'
import { preferDisplaySecondaryText } from './palette-secondary-text-display'

describe('preferDisplaySecondaryText', () => {
  it('re-bases ranges onto the relative path when the match lands inside it', () => {
    expect(
      preferDisplaySecondaryText({
        displayText: 'src/app.ts',
        matchedText: '/Users/me/repo/src/app.ts',
        ranges: [{ start: 19, end: 22 }]
      })
    ).toEqual({ text: 'src/app.ts', ranges: [{ start: 4, end: 7 }] })
  })

  it('keeps the absolute path when the match lives in the prefix', () => {
    expect(
      preferDisplaySecondaryText({
        displayText: 'src/app.ts',
        matchedText: '/Users/me/repo/src/app.ts',
        ranges: [{ start: 7, end: 9 }]
      })
    ).toEqual({ text: '/Users/me/repo/src/app.ts', ranges: [{ start: 7, end: 9 }] })
  })

  it('passes through when the matched text is already the display text', () => {
    expect(
      preferDisplaySecondaryText({
        displayText: 'src/app.ts',
        matchedText: 'src/app.ts',
        ranges: [{ start: 0, end: 3 }]
      })
    ).toEqual({ text: 'src/app.ts', ranges: [{ start: 0, end: 3 }] })
  })

  it('passes through when the display text is not a suffix of the match', () => {
    expect(
      preferDisplaySecondaryText({
        displayText: 'a fresh agent snippet',
        matchedText: 'something else',
        ranges: []
      })
    ).toEqual({ text: 'something else', ranges: [] })
  })
})
