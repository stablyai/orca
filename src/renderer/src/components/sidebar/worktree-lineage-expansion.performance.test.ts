import { describe, expect, it, vi } from 'vitest'
import { expandDraggedWorktreeIdsForVisibleLineage } from './worktree-manual-order'

describe('visible lineage expansion scaling', () => {
  it('reads each depth once even when every ancestor is selected', () => {
    let depthReads = 0
    const rows = Array.from({ length: 2_000 }, (_, index) => ({
      worktreeId: `wt-${index}`,
      get depth() {
        depthReads++
        return index
      }
    }))
    const selected = rows.map((row) => row.worktreeId)
    expect(expandDraggedWorktreeIdsForVisibleLineage(rows, selected)).toEqual(selected)
    expect(depthReads).toBe(rows.length)
  })

  it('deduplicates many absent selected rows without searching the growing result', () => {
    const selected = Array.from({ length: 5_000 }, (_, index) => `missing-${index}`)
    const includes = vi.spyOn(Array.prototype, 'includes')
    let calls: number
    let result: string[]
    try {
      result = expandDraggedWorktreeIdsForVisibleLineage([], [...selected, ...selected])
      calls = includes.mock.calls.length
    } finally {
      includes.mockRestore()
    }
    expect(result).toEqual(selected)
    expect(calls).toBe(0)
  })
})
