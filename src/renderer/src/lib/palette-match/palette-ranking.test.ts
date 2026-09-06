import { describe, expect, it } from 'vitest'
import type { PaletteDocumentRank } from './palette-document'
import {
  comparePaletteEntityRanks,
  createPaletteSearchContext,
  encodePaletteIdentity,
  maxValidPaletteActivityTimestamp,
  preparePaletteActivity
} from './palette-ranking'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const WEEK = 7 * DAY
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

function item(args: {
  rank?: PaletteDocumentRank
  timestamp?: number | null
  position?: number | readonly number[]
  identity?: string
}) {
  const context = createPaletteSearchContext(NOW)
  return {
    rank: args.rank ?? rank(),
    activity: preparePaletteActivity(args.timestamp, context),
    position: args.position ?? 0,
    identity: args.identity ?? 'id'
  }
}

describe('palette activity preparation', () => {
  it.each([
    [NOW, 0],
    [NOW - HOUR + 1, 0],
    [NOW - HOUR, 1],
    [NOW - DAY, 2],
    [NOW - WEEK, 3],
    [NOW - 2 * WEEK, 4],
    [NOW - 3 * WEEK, 5],
    [NOW - 80 * DAY, 13]
  ])('places timestamp %s in bucket %s', (timestamp, bucket) => {
    expect(preparePaletteActivity(timestamp, createPaletteSearchContext(NOW)).ageBucket).toBe(
      bucket
    )
  })

  it('keeps every known old timestamp ahead of invalid or unknown activity', () => {
    const context = createPaletteSearchContext(NOW)
    const old = preparePaletteActivity(1, context)
    for (const invalid of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const unknown = preparePaletteActivity(invalid, context)
      expect(old.ageBucket).not.toBeNull()
      expect(unknown).toEqual({ ageBucket: null, timestamp: 0 })
    }
  })

  it('clamps future clocks to the evaluation clock', () => {
    expect(preparePaletteActivity(NOW + DAY, createPaletteSearchContext(NOW))).toEqual({
      ageBucket: 0,
      timestamp: NOW
    })
  })

  it('ignores invalid values while reducing activity signals', () => {
    expect(
      maxValidPaletteActivityTimestamp([100, Number.NaN, 300, Number.POSITIVE_INFINITY, -1])
    ).toBe(300)
  })
})

describe('palette entity comparator', () => {
  it('keeps semantics ahead of recency', () => {
    const oldExact = item({ rank: rank({ strength: 0 }), timestamp: NOW - 80 * DAY })
    const recentWeak = item({ rank: rank({ strength: 1 }), timestamp: NOW })
    expect(comparePaletteEntityRanks(oldExact, recentWeak)).toBeLessThan(0)
  })

  it('uses age bucket before placement and placement before timestamp within a bucket', () => {
    const recentLater = item({ rank: rank({ placement: 2 }), timestamp: NOW - 30 * 60 * 1000 })
    const olderPrefix = item({ rank: rank({ placement: 0 }), timestamp: NOW - 2 * HOUR })
    expect(comparePaletteEntityRanks(recentLater, olderPrefix)).toBeLessThan(0)

    const sameBucketNewer = item({ rank: rank({ placement: 2 }), timestamp: NOW - 10 * 60 * 1000 })
    const sameBucketPrefix = item({ rank: rank({ placement: 0 }), timestamp: NOW - 50 * 60 * 1000 })
    expect(comparePaletteEntityRanks(sameBucketPrefix, sameBucketNewer)).toBeLessThan(0)
  })

  it('uses timestamp, position tuple, and fixed code-unit identity for successive ties', () => {
    expect(
      comparePaletteEntityRanks(
        item({ timestamp: NOW - 1, position: 9, identity: 'z' }),
        item({ timestamp: NOW - 2, position: 0, identity: 'a' })
      )
    ).toBeLessThan(0)
    expect(
      comparePaletteEntityRanks(
        item({ timestamp: NOW, position: [0, 9], identity: 'z' }),
        item({ timestamp: NOW, position: [1, 0], identity: 'a' })
      )
    ).toBeLessThan(0)
    expect(
      comparePaletteEntityRanks(
        item({ timestamp: NOW, position: 0, identity: 'A' }),
        item({ timestamp: NOW, position: 0, identity: 'a' })
      )
    ).toBeLessThan(0)
  })

  it('is permutation-invariant for unique qualified identities', () => {
    const rows = [
      item({
        timestamp: NOW - 2 * HOUR,
        identity: encodePaletteIdentity(['browser', 'host-b', '1'])
      }),
      item({
        timestamp: NOW - 20 * 60 * 1000,
        identity: encodePaletteIdentity(['tab', 'host-a', '1'])
      }),
      item({
        timestamp: NOW - 20 * 60 * 1000,
        identity: encodePaletteIdentity(['tab', 'host-b', '1'])
      })
    ]
    const expected = [...rows].sort(comparePaletteEntityRanks).map((row) => row.identity)
    expect(
      rows
        .toReversed()
        .sort(comparePaletteEntityRanks)
        .map((row) => row.identity)
    ).toEqual(expected)
  })

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
