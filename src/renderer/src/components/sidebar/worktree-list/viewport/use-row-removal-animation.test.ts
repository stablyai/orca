import { describe, expect, it } from 'vitest'
import {
  buildVirtualRowRemovalMotions,
  type VirtualRowLayoutSnapshot
} from './use-row-removal-animation'

function snapshot(args: {
  identities: string[]
  scrollTop: number
  starts: [string, number][]
}): VirtualRowLayoutSnapshot {
  return {
    rowIdentityKeys: new Set(args.identities),
    scrollTop: args.scrollTop,
    startsByKey: new Map(args.starts)
  }
}

describe('buildVirtualRowRemovalMotions', () => {
  it('moves surviving rows from their pre-delete viewport positions', () => {
    const motions = buildVirtualRowRemovalMotions({
      previous: snapshot({
        identities: ['wt:a', 'wt:b', 'wt:c'],
        scrollTop: 100,
        starts: [
          ['wt:a', 100],
          ['wt:b', 220],
          ['wt:c', 340]
        ]
      }),
      current: snapshot({
        identities: ['wt:a', 'wt:c'],
        scrollTop: 100,
        starts: [
          ['wt:a', 100],
          ['wt:c', 220]
        ]
      }),
      rekeyedRowKeys: new Map()
    })

    expect(motions).toEqual([{ key: 'wt:c', deltaY: 120 }])
  })

  it('does not double-move rows when anchor restoration offsets a deletion above the viewport', () => {
    const motions = buildVirtualRowRemovalMotions({
      previous: snapshot({
        identities: ['wt:deleted', 'wt:a'],
        scrollTop: 240,
        starts: [['wt:a', 240]]
      }),
      current: snapshot({
        identities: ['wt:a'],
        scrollTop: 120,
        starts: [['wt:a', 120]]
      }),
      rekeyedRowKeys: new Map()
    })

    expect(motions).toEqual([])
  })

  it('follows a surviving row through a lineage rekey', () => {
    const motions = buildVirtualRowRemovalMotions({
      previous: snapshot({
        identities: ['wt:parent', 'wt:child'],
        scrollTop: 0,
        starts: [['lineage-group:parent', 100]]
      }),
      current: snapshot({
        identities: ['wt:parent'],
        scrollTop: 0,
        starts: [['wt:parent', 100]]
      }),
      rekeyedRowKeys: new Map([['lineage-group:parent', 'wt:parent']])
    })

    expect(motions).toEqual([])
  })

  it('ignores additions and measurement-only movement', () => {
    const previous = snapshot({
      identities: ['wt:a'],
      scrollTop: 0,
      starts: [['wt:a', 100]]
    })
    expect(
      buildVirtualRowRemovalMotions({
        previous,
        current: snapshot({
          identities: ['wt:a', 'wt:b'],
          scrollTop: 0,
          starts: [['wt:a', 140]]
        }),
        rekeyedRowKeys: new Map()
      })
    ).toEqual([])
  })
})
