import { describe, expect, it } from 'vitest'
import {
  bestPaletteQualityRank,
  comparePaletteRankedItems,
  NO_PALETTE_QUALITY_RANK,
  paletteQualityRank,
  shouldIntentSectionLeadPaletteSections,
  shouldOpenTabsLeadPaletteSections
} from './cmd-j-section-leadership'
import type { PaletteDocumentRank } from './palette-match/palette-document'

function rank(overrides: Partial<PaletteDocumentRank> = {}): PaletteDocumentRank {
  return {
    exactIntent: 1,
    matchedDirectField: 0,
    wholeQuery: 3,
    worstQuality: 5,
    usesSupportingEvidence: 0,
    fuzzyTokenCount: 0,
    fieldHopCount: 1,
    ...overrides
  }
}

describe('palette quality ranks', () => {
  it('orders the shared classes from exact intent to fuzzy evidence', () => {
    expect(paletteQualityRank('exact-intent')).toBeLessThan(paletteQualityRank('exact-visible'))
    expect(paletteQualityRank('exact-visible')).toBeLessThan(paletteQualityRank('visible-prefix'))
    expect(paletteQualityRank('visible-prefix')).toBeLessThan(paletteQualityRank('exact-evidence'))
    expect(paletteQualityRank('exact-evidence')).toBeLessThan(
      paletteQualityRank('partial-evidence')
    )
    expect(paletteQualityRank('partial-evidence')).toBeLessThan(
      paletteQualityRank('fuzzy-evidence')
    )
  })

  it('treats a missing class as no match', () => {
    expect(paletteQualityRank(null)).toBe(NO_PALETTE_QUALITY_RANK)
    expect(bestPaletteQualityRank([null, undefined])).toBe(NO_PALETTE_QUALITY_RANK)
  })

  it('picks the strongest class in a section', () => {
    expect(bestPaletteQualityRank(['fuzzy-evidence', 'exact-visible', null])).toBe(
      paletteQualityRank('exact-visible')
    )
  })
})

describe('section leadership', () => {
  it('prefers open tabs on a tie', () => {
    expect(
      shouldOpenTabsLeadPaletteSections({ bestWorktreeQualityRank: 2, bestOpenTabQualityRank: 2 })
    ).toBe(true)
  })

  it('lets the stronger section lead', () => {
    expect(
      shouldOpenTabsLeadPaletteSections({ bestWorktreeQualityRank: 1, bestOpenTabQualityRank: 4 })
    ).toBe(false)
  })

  it('keeps open tabs ahead when neither section matched', () => {
    expect(
      shouldOpenTabsLeadPaletteSections({
        bestWorktreeQualityRank: NO_PALETTE_QUALITY_RANK,
        bestOpenTabQualityRank: NO_PALETTE_QUALITY_RANK
      })
    ).toBe(true)
  })
})

describe('intent section leadership', () => {
  it('leads a fuzzy entity hit', () => {
    expect(
      shouldIntentSectionLeadPaletteSections({
        bestEntityQualityRank: paletteQualityRank('fuzzy-evidence'),
        bestIntentQualityRank: paletteQualityRank('exact-intent')
      })
    ).toBe(true)
  })

  it('never displaces an exact visible entity match', () => {
    expect(
      shouldIntentSectionLeadPaletteSections({
        bestEntityQualityRank: paletteQualityRank('exact-visible'),
        bestIntentQualityRank: paletteQualityRank('exact-intent')
      })
    ).toBe(false)
  })

  it('stays behind when its own hit is no stronger', () => {
    expect(
      shouldIntentSectionLeadPaletteSections({
        bestEntityQualityRank: paletteQualityRank('visible-prefix'),
        bestIntentQualityRank: paletteQualityRank('partial-evidence')
      })
    ).toBe(false)
  })

  it('leads when the entity sections matched nothing', () => {
    expect(
      shouldIntentSectionLeadPaletteSections({
        bestEntityQualityRank: NO_PALETTE_QUALITY_RANK,
        bestIntentQualityRank: paletteQualityRank('partial-evidence')
      })
    ).toBe(true)
  })
})

describe('ranked item comparison', () => {
  it('compares match rank lexicographically before list order', () => {
    const strong = { rank: rank({ wholeQuery: 0 }), order: 99, id: 'b' }
    const weak = { rank: rank({ wholeQuery: 2 }), order: 0, id: 'a' }
    expect(comparePaletteRankedItems(strong, weak)).toBeLessThan(0)
  })

  it('prefers recently active item when match rank ties', () => {
    const recent = { rank: rank(), order: 10, id: 'z', lastActiveAt: 2000 }
    const older = { rank: rank(), order: 0, id: 'a', lastActiveAt: 1000 }
    expect(comparePaletteRankedItems(recent, older)).toBeLessThan(0)
  })

  it('falls back to the section order when match rank and recency tie', () => {
    const first = { rank: rank(), order: 1, id: 'z', lastActiveAt: 1000 }
    const second = { rank: rank(), order: 2, id: 'a', lastActiveAt: 1000 }
    expect(comparePaletteRankedItems(first, second)).toBeLessThan(0)
  })

  it('breaks a full tie on the stable id', () => {
    const a = { rank: rank(), order: 1, id: 'a' }
    const b = { rank: rank(), order: 1, id: 'b' }
    expect(comparePaletteRankedItems(a, b)).toBeLessThan(0)
  })

  it('keeps unmatched rows behind matched ones', () => {
    const matched = { rank: rank(), order: 9, id: 'z' }
    const unmatched = { rank: null, order: 0, id: 'a' }
    expect(comparePaletteRankedItems(matched, unmatched)).toBeLessThan(0)
  })

  it('orders empty-query rows by their section order alone', () => {
    const a = { rank: null, order: 0, id: 'z' }
    const b = { rank: null, order: 1, id: 'a' }
    expect(comparePaletteRankedItems(a, b)).toBeLessThan(0)
  })
})
