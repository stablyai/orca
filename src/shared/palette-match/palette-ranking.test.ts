import { describe, expect, it } from 'vitest'
import type { PaletteDocumentRank } from './palette-document'
import {
  comparePaletteEntityRanks,
  createPaletteSearchContext,
  preparePaletteActivity
} from './palette-ranking'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = 100 * DAY

function rank(overrides: Partial<PaletteDocumentRank> = {}): PaletteDocumentRank {
  return {
    destination: 2,
    recovery: 0,
    wordMatch: 0,
    coverage: 0,
    containerOnlyTokenCount: 0,
    recoveryTokenCount: 0,
    strength: 0,
    placement: 2,
    ...overrides
  }
}

describe('palette entity comparator', () => {
  it('separates future-clamped clocks once evaluation passes the earlier stamp', () => {
    const earlierFuture = NOW + HOUR
    const laterFuture = NOW + 2 * HOUR
    const before = createPaletteSearchContext(NOW)
    const afterEarlier = createPaletteSearchContext(NOW + HOUR + 1)
    const build = (timestamp: number, context: ReturnType<typeof createPaletteSearchContext>) => ({
      rank: rank(),
      activity: preparePaletteActivity(timestamp, context),
      position: 0,
      identity: String(timestamp)
    })

    expect(build(earlierFuture, before).activity).toEqual(build(laterFuture, before).activity)
    expect(
      comparePaletteEntityRanks(
        build(laterFuture, afterEarlier),
        build(earlierFuture, afterEarlier)
      )
    ).toBeLessThan(0)
  })
})
