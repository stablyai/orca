import { describe, expect, it } from 'vitest'
import { compareSmartStamps, recentStamp, type StampOrderRow } from './stamp-order'

function sortSmart(rows: Record<string, StampOrderRow>): string[] {
  return Object.entries(rows)
    .sort(([, a], [, b]) => compareSmartStamps(a, b))
    .map(([id]) => id)
}

describe('stamp order', () => {
  it('ranks Needs you, Done, Working, then Rest, each newest first', () => {
    expect(
      sortSmart({
        rest: { lastActivityAt: 900 },
        working: { lastActivityAt: 1, smartTier: 'working', smartAt: 50 },
        doneOld: { lastActivityAt: 1, smartTier: 'done', smartAt: 10 },
        doneNew: { lastActivityAt: 1, smartTier: 'done', smartAt: 20 },
        needsYou: { lastActivityAt: 1, smartTier: 'needs-you', smartAt: 5 },
        restOld: { lastActivityAt: 100 }
      })
    ).toEqual(['needsYou', 'doneNew', 'doneOld', 'working', 'rest', 'restOld'])
  })

  it('reads a tier it does not know, and missing or broken stamps, as Rest', () => {
    // A newer host's tier, parsed off the wire as this client receives it.
    const unknownTier: StampOrderRow = JSON.parse(
      '{"lastActivityAt":30,"smartTier":"later","smartAt":99}'
    )
    expect(
      sortSmart({
        unknown: unknownTier,
        broken: { lastActivityAt: Number.NaN },
        missing: {},
        recent: { lastActivityAt: 40 }
      })
    ).toEqual(['recent', 'unknown', 'broken', 'missing'])
    expect(recentStamp({ lastActivityAt: Number.POSITIVE_INFINITY })).toBe(0)
  })

  it('ties within a tier fall to Recent', () => {
    expect(
      sortSmart({
        older: { lastActivityAt: 1, smartTier: 'done', smartAt: 5 },
        newer: { lastActivityAt: 2, smartTier: 'done', smartAt: 5 }
      })
    ).toEqual(['newer', 'older'])
  })
})
