import { describe, expect, it, vi } from 'vitest'
import {
  expandDraggedWorktreeIdsForVisibleLineage,
  type WorktreeDragLineageRow
} from './worktree-manual-order'

// Preserve the original traversal as an independent ordering oracle.
function referenceExpansion(
  rows: readonly WorktreeDragLineageRow[],
  draggedIds: readonly string[]
) {
  const dragged = new Set(draggedIds)
  const expanded = new Set(draggedIds)
  const rowIds = new Set(rows.map((row) => row.worktreeId))
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (!dragged.has(row.worktreeId)) {
      continue
    }
    for (let cursor = index + 1; cursor < rows.length; cursor++) {
      const child = rows[cursor]
      if (child.depth <= row.depth) {
        break
      }
      expanded.add(child.worktreeId)
    }
  }
  const result = rows.filter((row) => expanded.has(row.worktreeId)).map((row) => row.worktreeId)
  for (const id of draggedIds) {
    if (!rowIds.has(id) && !result.includes(id)) {
      result.push(id)
    }
  }
  return result
}

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
    expect(referenceExpansion(rows, selected)).toEqual(selected)
    expect(depthReads).toBe(rows.length * (rows.length - 1))
    depthReads = 0
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

  it('matches the previous algorithm across duplicate rows, missing IDs and depth boundaries', () => {
    let seed = 12345
    function random(limit: number): number {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % limit
    }
    const depths = [-1, 0, 1, 2, 3, 20, Infinity, -Infinity, Number.NaN]
    for (let sample = 0; sample < 500; sample++) {
      const rows = Array.from({ length: random(40) }, () => ({
        worktreeId: `wt-${random(20)}`,
        depth: depths[random(depths.length)]
      }))
      const selected = Array.from({ length: random(20) }, () => `wt-${random(25)}`)
      expect(expandDraggedWorktreeIdsForVisibleLineage(rows, selected)).toEqual(
        referenceExpansion(rows, selected)
      )
    }
  })
})
