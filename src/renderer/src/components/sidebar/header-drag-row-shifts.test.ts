import { describe, expect, it } from 'vitest'

import { computeHeaderDragRowShifts } from './header-drag-row-shifts'

// Two group units, each a header + one worktree child:
//   unit A: header@0, child@20   (block, height 40: 0..40)
//   unit B: header@40, child@60
//   unit C: header@80, child@100
const units = [
  { headerTop: 0, rowKeys: ['a-hdr', 'a-wt'] },
  { headerTop: 40, rowKeys: ['b-hdr', 'b-wt'] },
  { headerTop: 80, rowKeys: ['c-hdr', 'c-wt'] }
]

describe('computeHeaderDragRowShifts', () => {
  it('shifts a whole unit (header + children) together when moving down', () => {
    const offsets = computeHeaderDragRowShifts({
      units,
      blockKeys: new Set(['a-hdr', 'a-wt']),
      blockTop: 0,
      blockBottom: 40,
      dropY: 80
    })
    // unit B is between the block (bottom 40) and the drop line (80): both its
    // header AND its child shift up by the block height — no detaching.
    expect(offsets.get('b-hdr')).toBe(-40)
    expect(offsets.get('b-wt')).toBe(-40)
    // unit C is at/after the drop line — it stays put.
    expect(offsets.has('c-hdr')).toBe(false)
    expect(offsets.has('c-wt')).toBe(false)
    // the dragged unit never shifts (it is hidden).
    expect(offsets.has('a-hdr')).toBe(false)
  })

  it('shifts whole units down together when moving up', () => {
    const offsets = computeHeaderDragRowShifts({
      units,
      blockKeys: new Set(['c-hdr', 'c-wt']),
      blockTop: 80,
      blockBottom: 120,
      dropY: 40
    })
    // unit B (header@40) is between the drop line and the block: shifts down.
    expect(offsets.get('b-hdr')).toBe(40)
    expect(offsets.get('b-wt')).toBe(40)
    // unit A (header@0) is above the drop line — stays.
    expect(offsets.has('a-hdr')).toBe(false)
  })

  it('returns no offsets when the block has no height', () => {
    expect(
      computeHeaderDragRowShifts({
        units,
        blockKeys: new Set(['a-hdr', 'a-wt']),
        blockTop: 10,
        blockBottom: 10,
        dropY: 80
      }).size
    ).toBe(0)
  })
})
