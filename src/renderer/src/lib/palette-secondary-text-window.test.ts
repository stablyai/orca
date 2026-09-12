import { describe, expect, it } from 'vitest'
import {
  PALETTE_SECONDARY_TEXT_BUDGET,
  windowPaletteSecondaryText
} from './palette-secondary-text-window'

const URL = 'help.pulley.com/en/articles/4856643-how-do-i-convert-a-safe-or-convertible-note'
const LONG_HOST_URL = 'knowledge.workspace.google.com/admin/is-there-a-log-of-messages-sent'

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
    expect(result.text).toBe('help.pulley.com/en/articl…')
    expect(result.text.length).toBe(PALETTE_SECONDARY_TEXT_BUDGET)
    expect(result.elided).toBe(true)
  })

  it('keeps the host and pulls in a window around a match past the budget', () => {
    const start = URL.indexOf('safe')
    const result = windowPaletteSecondaryText(URL, [{ start, end: start + 4 }])
    expect(result.text).toBe('help.pulley.com…rt-a-safe…')
    expect(highlighted(result.text, result.ranges)).toBe('safe')
  })

  it('trims a long host rather than giving up the match window', () => {
    const start = LONG_HOST_URL.indexOf('messages')
    const result = windowPaletteSecondaryText(LONG_HOST_URL, [{ start, end: start + 8 }])
    expect(result.text).toBe('knowledge.worksp…messages…')
    expect(highlighted(result.text, result.ranges)).toBe('messages')
  })

  it('rebases every match the window still shows', () => {
    const first = URL.indexOf('pulley')
    const second = URL.indexOf('articles')
    const result = windowPaletteSecondaryText(URL, [
      { start: first, end: first + 6 },
      { start: second, end: second + 8 }
    ])
    expect(highlighted(result.text, result.ranges)).toBe('pulley|articl')
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
    expect(result.text).toBe('help.pulley.com…ible-note')
    expect(highlighted(result.text, result.ranges)).toBe('note')
  })

  it('joins the head to the window with no gap when they are contiguous', () => {
    const result = windowPaletteSecondaryText(URL, [{ start: 21, end: 41 }])
    expect(result.text).toBe('help.pulley.com…ticles/48…')
    expect(highlighted(result.text, result.ranges)).toBe('ticles/48')
  })

  it('falls back to head truncation when the budget leaves no room to jump', () => {
    const start = URL.indexOf('safe')
    const result = windowPaletteSecondaryText(URL, [{ start, end: start + 4 }], 12)
    expect(result.text).toBe('help.pulley…')
  })
})
