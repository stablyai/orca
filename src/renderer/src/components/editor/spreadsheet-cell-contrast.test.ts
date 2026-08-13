import { describe, expect, it } from 'vitest'
import {
  getContrastRatio,
  getRelativeLuminance,
  isLargeCellText,
  pickReadableCellTextColor
} from './spreadsheet-cell-contrast'

describe('getRelativeLuminance', () => {
  it('anchors black at 0 and white at 1', () => {
    expect(getRelativeLuminance('#000000')).toBe(0)
    expect(getRelativeLuminance('#ffffff')).toBeCloseTo(1, 5)
  })

  it('weights green above red above blue, as the eye does', () => {
    const red = getRelativeLuminance('#ff0000')!
    const green = getRelativeLuminance('#00ff00')!
    const blue = getRelativeLuminance('#0000ff')!

    expect(green).toBeGreaterThan(red)
    expect(red).toBeGreaterThan(blue)
  })

  it('returns null for a value that is not a colour', () => {
    expect(getRelativeLuminance('rebeccapurple')).toBeNull()
    expect(getRelativeLuminance('')).toBeNull()
  })
})

describe('getContrastRatio', () => {
  it('spans 1 for identical colours to 21 for black on white', () => {
    expect(getContrastRatio('#123456', '#123456')).toBeCloseTo(1, 5)
    expect(getContrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
  })

  it('is symmetric in its arguments', () => {
    expect(getContrastRatio('#1f4e78', '#ffffff')).toBeCloseTo(
      getContrastRatio('#ffffff', '#1f4e78'),
      10
    )
  })

  it('degrades to 1 when a colour cannot be read, so nothing is assumed legible', () => {
    expect(getContrastRatio('not-a-color', '#ffffff')).toBe(1)
  })
})

describe('pickReadableCellTextColor', () => {
  it('inks a light fill black and a dark fill white', () => {
    // Excel's own yellow input cell, and a dark blue header band.
    expect(pickReadableCellTextColor('#ffff00')).toBe('#000000')
    expect(pickReadableCellTextColor('#1f4e78')).toBe('#ffffff')
  })

  it("keeps the workbook's font colour when it is legible on the fill", () => {
    // Why: white bold on a dark header is the author's intent, not an accident.
    expect(pickReadableCellTextColor('#1f4e78', '#ffffff')).toBe('#ffffff')
    expect(pickReadableCellTextColor('#e2efda', '#333333')).toBe('#333333')
  })

  it("overrides the workbook's font colour when it would be unreadable", () => {
    // A yellow fill carrying a white font is what makes a cell vanish.
    expect(pickReadableCellTextColor('#ffff00', '#ffffff')).toBe('#000000')
    expect(pickReadableCellTextColor('#1f4e78', '#000080')).toBe('#ffffff')
  })

  it('falls back to the luminance choice for an absent or unreadable font colour', () => {
    expect(pickReadableCellTextColor('#ffff00', null)).toBe('#000000')
    expect(pickReadableCellTextColor('#ffff00', undefined)).toBe('#000000')
    expect(pickReadableCellTextColor('#ffff00', 'inherit')).toBe('#000000')
  })

  it('always returns ink that clears the AA threshold on the fill', () => {
    for (const fill of ['#ffff00', '#1f4e78', '#808080', '#e2efda', '#4472c4', '#ffffff']) {
      const ink = pickReadableCellTextColor(fill)
      expect(getContrastRatio(ink, fill)).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('large text contrast', () => {
  it('recognizes WCAG large text by size and by bold', () => {
    expect(isLargeCellText({ sizePt: 18 })).toBe(true)
    expect(isLargeCellText({ sizePt: 14, bold: true })).toBe(true)
    expect(isLargeCellText({ sizePt: 14 })).toBe(false)
    expect(isLargeCellText({ sizePt: 11, bold: true })).toBe(false)
    expect(isLargeCellText({})).toBe(false)
  })

  it('keeps an accent colour on a heading that only clears the large-text ratio', () => {
    // Why: a brand orange title on white is 3.1:1 — below the body threshold but
    // above the large-text one, and it is what Excel and Sheets both show.
    // Replacing it with black would discard a deliberate design decision.
    expect(getContrastRatio('#f46524', '#ffffff')).toBeLessThan(4.5)
    expect(getContrastRatio('#f46524', '#ffffff')).toBeGreaterThan(3)

    expect(pickReadableCellTextColor('#ffffff', '#f46524', { sizePt: 18, bold: true })).toBe(
      '#f46524'
    )
  })

  it('still replaces that colour for body text', () => {
    expect(pickReadableCellTextColor('#ffffff', '#f46524', { sizePt: 11 })).toBe('#000000')
  })

  it('replaces a colour that fails even the large-text ratio', () => {
    expect(pickReadableCellTextColor('#ffff00', '#ffffff', { sizePt: 24, bold: true })).toBe(
      '#000000'
    )
  })
})
