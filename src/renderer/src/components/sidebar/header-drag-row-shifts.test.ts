import { describe, expect, it } from 'vitest'

import { computeHeaderDragRowShifts } from './header-drag-row-shifts'

const rows = [
  { key: 'a', top: 0 }, // block (height 20: 0..20)
  { key: 'b', top: 20 },
  { key: 'c', top: 40 },
  { key: 'd', top: 60 }
]

describe('computeHeaderDragRowShifts', () => {
  it('shifts the rows between the block and the drop line up when moving down', () => {
    const offsets = computeHeaderDragRowShifts({
      rows,
      blockKeys: new Set(['a']),
      blockTop: 0,
      blockBottom: 20,
      dropY: 60
    })
    // b and c are between the block bottom (20) and the drop line (60).
    expect(offsets.get('b')).toBe(-20)
    expect(offsets.get('c')).toBe(-20)
    // d is at/after the drop line — it stays put (block lands above it).
    expect(offsets.has('d')).toBe(false)
    // the dragged block row is never shifted (it is hidden).
    expect(offsets.has('a')).toBe(false)
  })

  it('shifts the rows between the drop line and the block down when moving up', () => {
    const offsets = computeHeaderDragRowShifts({
      rows,
      blockKeys: new Set(['d']),
      blockTop: 60,
      blockBottom: 80,
      dropY: 20
    })
    // b and c are between the drop line (20) and the block (60).
    expect(offsets.get('b')).toBe(20)
    expect(offsets.get('c')).toBe(20)
    expect(offsets.has('a')).toBe(false)
    expect(offsets.has('d')).toBe(false)
  })

  it('returns no offsets when the block has no height', () => {
    expect(
      computeHeaderDragRowShifts({
        rows,
        blockKeys: new Set(['a']),
        blockTop: 10,
        blockBottom: 10,
        dropY: 60
      }).size
    ).toBe(0)
  })
})
