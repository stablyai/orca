import { describe, expect, it } from 'vitest'
import {
  PALETTE_SECONDARY_TEXT_BUDGET,
  windowPaletteSecondaryText
} from './palette-secondary-text-window'

const URL = 'help.pulley.com/en/articles/4856643-how-do-i-convert-a-safe-or-convertible-note'

function highlighted(text: string, ranges: readonly { start: number; end: number }[]): string {
  return ranges.map((range) => text.slice(range.start, range.end)).join('|')
}

describe('windowPaletteSecondaryText', () => {
  it('leaves text within the budget untouched', () => {
    const ranges = [{ start: 0, end: 4 }]
    const result = windowPaletteSecondaryText('src/lib/tabs.ts', ranges)
    expect(result).toEqual({ text: 'src/lib/tabs.ts', ranges, elided: false })
  })

  it('keeps the head and trims the tail when nothing matched', () => {
    const result = windowPaletteSecondaryText(URL)
    expect(result.text).toBe('help.pulley.com/en/articles/4856643-h…')
    expect(result.text.length).toBe(PALETTE_SECONDARY_TEXT_BUDGET)
    expect(result.elided).toBe(true)
  })

  it('keeps the host and pulls in a window around a match past the budget', () => {
    const start = URL.indexOf('safe')
    const result = windowPaletteSecondaryText(URL, [{ start, end: start + 4 }])
    expect(result.text).toBe('help.pulley.com…ert-a-safe-or-convert…')
    expect(highlighted(result.text, result.ranges)).toBe('safe')
  })

  it('rebases every match the window still shows', () => {
    const first = URL.indexOf('pulley')
    const second = URL.indexOf('articles')
    const result = windowPaletteSecondaryText(URL, [
      { start: first, end: first + 6 },
      { start: second, end: second + 8 }
    ])
    expect(highlighted(result.text, result.ranges)).toBe('pulley|articles')
  })

  it('drops matches the window cut away', () => {
    const start = URL.length - 4
    const result = windowPaletteSecondaryText(URL, [
      { start: 0, end: 4 },
      { start, end: start + 4 }
    ])
    expect(highlighted(result.text, result.ranges)).toBe('help')
  })

  it('clamps the window to the end of the text', () => {
    const start = URL.length - 4
    const result = windowPaletteSecondaryText(URL, [{ start, end: start + 4 }])
    expect(result.text.endsWith('note')).toBe(true)
    expect(highlighted(result.text, result.ranges)).toBe('note')
  })

  it('joins the head to the window with no gap when they are contiguous', () => {
    const start = URL.indexOf('articles') + 1
    const result = windowPaletteSecondaryText(URL, [{ start, end: start + 20 }])
    expect(result.text).toBe('help.pulley.com/en/articles/4856643-…')
    expect(highlighted(result.text, result.ranges)).toBe('rticles/4856643-')
  })

  it('falls back to head truncation when the budget leaves no useful window', () => {
    const start = URL.indexOf('safe')
    const result = windowPaletteSecondaryText(URL, [{ start, end: start + 4 }], 24)
    expect(result.text).toBe('help.pulley.com/en/arti…')
  })
})
