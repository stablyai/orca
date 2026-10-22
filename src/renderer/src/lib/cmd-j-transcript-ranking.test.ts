import { describe, expect, it } from 'vitest'
import {
  comparePaletteRankedItems,
  paletteQualityRank,
  shouldIntentSectionLeadPaletteSections,
  shouldOpenTabsLeadPaletteSections
} from './cmd-j-section-leadership'
import {
  cmdJEffectiveQualityRank,
  compareCmdJTranscriptRankedItems,
  type CmdJTranscriptRankedItem
} from './cmd-j-transcript-ranking'
import {
  createPaletteFallbackRank,
  type PaletteDocumentRank
} from './palette-match/palette-document'

function ordinary(
  identity: string,
  qualityClass: CmdJTranscriptRankedItem['qualityClass'],
  changes: Partial<PaletteDocumentRank> = {}
): CmdJTranscriptRankedItem {
  return {
    identity,
    qualityClass,
    rank: { ...createPaletteFallbackRank(), destination: 2, ...changes },
    order: 0
  }
}
const ordinaryFixtures = [
  ordinary('recognized review URL', 'exact-intent', { destination: 0 }),
  ordinary('whole workspace name', 'exact-visible', { destination: 1 }),
  ordinary('structured exact title', 'exact-visible'),
  ordinary('visible prefix', 'visible-prefix', { wordMatch: 1 }),
  ordinary('weak supporting field', 'partial-evidence', { wordMatch: 2 }),
  ordinary('complete fuzzy title', 'fuzzy-evidence', { recovery: 1 }),
  ordinary('fallback exact evidence', 'exact-evidence', { destination: 3 })
]
const identities = (items: readonly CmdJTranscriptRankedItem[]) =>
  items.map((item) => item.identity)

it('records the ordinary-only cross-band reversal independently of transcript availability', () => {
  expect(identities([...ordinaryFixtures].sort(comparePaletteRankedItems))).toEqual([
    'recognized review URL',
    'whole workspace name',
    'structured exact title',
    'visible prefix',
    'weak supporting field',
    'complete fuzzy title',
    'fallback exact evidence'
  ])
  const approved = [
    'recognized review URL',
    'whole workspace name',
    'structured exact title',
    'visible prefix',
    'fallback exact evidence',
    'weak supporting field',
    'complete fuzzy title'
  ]
  for (const _availability of ['absent', 'disabled', 'unavailable', 'failed', 'in flight']) {
    expect(identities([...ordinaryFixtures].sort(compareCmdJTranscriptRankedItems))).toEqual(
      approved
    )
  }
})

it('inserts complete transcripts between protected ordinary and weak ordinary, without recency overriding ordinal', () => {
  const complete: CmdJTranscriptRankedItem = {
    identity: 'complete',
    rank: null,
    qualityClass: null,
    order: 0,
    transcript: { complete: true, ordinal: 8 },
    activity: { ageBucket: 0, timestamp: 999 }
  }
  const earlier = {
    ...complete,
    identity: 'earlier',
    transcript: { complete: true, ordinal: 2 },
    activity: { ageBucket: null, timestamp: 0 }
  }
  const unproven = {
    ...complete,
    identity: 'unproven',
    transcript: { complete: false, ordinal: 0 }
  }
  expect(
    identities(
      [...ordinaryFixtures, complete, earlier, unproven].sort(compareCmdJTranscriptRankedItems)
    )
  ).toEqual([
    'recognized review URL',
    'whole workspace name',
    'structured exact title',
    'visible prefix',
    'fallback exact evidence',
    'earlier',
    'complete',
    'weak supporting field',
    'complete fuzzy title',
    'unproven'
  ])
})

it('retains ordinary activity/position/identity ties inside bands', () => {
  const base = ordinary('a', 'partial-evidence')
  const recent = { ...base, identity: 'recent', activity: { ageBucket: 0, timestamp: 999 } }
  const old = { ...base, identity: 'old', activity: { ageBucket: 1, timestamp: 99 } }
  expect(compareCmdJTranscriptRankedItems(recent, old)).toBe(comparePaletteRankedItems(recent, old))
  expect(compareCmdJTranscriptRankedItems(base, { ...base, identity: 'b' })).toBeLessThan(0)
  expect(compareCmdJTranscriptRankedItems(base, { ...base, order: 1 })).toBeLessThan(0)
})

it('uses the transcript band consistently for section leadership, preserving ordinary distinctions', () => {
  const transcript = cmdJEffectiveQualityRank(null, true)
  expect(transcript).toBeGreaterThan(paletteQualityRank('exact-evidence'))
  expect(transcript).toBeLessThan(paletteQualityRank('partial-evidence'))
  expect(
    shouldOpenTabsLeadPaletteSections({
      bestOpenTabQualityRank: transcript,
      bestWorktreeQualityRank: paletteQualityRank('partial-evidence')
    })
  ).toBe(true)
  expect(
    shouldOpenTabsLeadPaletteSections({
      bestOpenTabQualityRank: transcript,
      bestWorktreeQualityRank: paletteQualityRank('visible-prefix')
    })
  ).toBe(false)
  expect(
    shouldIntentSectionLeadPaletteSections({
      bestEntityQualityRank: cmdJEffectiveQualityRank('exact-visible', true),
      bestIntentQualityRank: paletteQualityRank('exact-intent')
    })
  ).toBe(false)
})

describe('fixed comparison keys', () => {
  it('are antisymmetric, transitive, and deterministic, including merged signals and stable ties', () => {
    const rows: CmdJTranscriptRankedItem[] = [
      ...ordinaryFixtures,
      ...ordinaryFixtures.map((item, ordinal) => ({
        ...item,
        identity: `merged ${item.identity}`,
        transcript: { complete: true, ordinal }
      })),
      ...Array.from({ length: 5 }, (_, ordinal) => ({
        identity: `index ${ordinal}`,
        rank: null,
        qualityClass: null,
        order: 0,
        transcript: { complete: ordinal % 2 === 0, ordinal }
      }))
    ]
    const compare = compareCmdJTranscriptRankedItems
    for (const a of rows) {
      for (const b of rows) {
        expect(Math.sign(compare(a, b)) + Math.sign(compare(b, a))).toBe(0)
        for (const c of rows) {
          if (compare(a, b) <= 0 && compare(b, c) <= 0) {
            expect(compare(a, c)).toBeLessThanOrEqual(0)
          }
        }
      }
    }
    expect(identities([...rows].toReversed().sort(compare))).toEqual(
      identities([...rows].sort(compare))
    )
  })
})
