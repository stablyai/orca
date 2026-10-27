import { describe, expect, it } from 'vitest'
import {
  computeWorkspaceGridViewCellRects,
  workspaceGridViewCellEdges
} from './workspace-grid-view-cell-rects'

describe('workspaceGridViewCellEdges', () => {
  it('finds the window corners of a two by two grid', () => {
    expect(computeWorkspaceGridViewCellRects(4).map(workspaceGridViewCellEdges)).toEqual([
      { top: true, left: true, right: false, bottom: false },
      { top: true, left: false, right: true, bottom: false },
      { top: false, left: true, right: false, bottom: true },
      { top: false, left: false, right: true, bottom: true }
    ])
  })

  it('tolerates rounding so a cell ending just short of 100% still touches the edge', () => {
    expect(
      workspaceGridViewCellEdges({ left: 66.66666, top: 49.99999, width: 33.33333, height: 50 })
    ).toEqual({ top: false, left: false, right: true, bottom: true })
  })
})

function totalArea(count: number): number {
  return computeWorkspaceGridViewCellRects(count).reduce(
    (sum, rect) => sum + rect.width * rect.height,
    0
  )
}

describe('computeWorkspaceGridViewCellRects', () => {
  it('returns no cells for an empty grid view', () => {
    expect(computeWorkspaceGridViewCellRects(0)).toEqual([])
  })

  it('places two workspaces side by side', () => {
    expect(computeWorkspaceGridViewCellRects(2)).toEqual([
      { left: 0, top: 0, width: 50, height: 100 },
      { left: 50, top: 0, width: 50, height: 100 }
    ])
  })

  it('stretches the single cell of a short last row across the full width', () => {
    expect(computeWorkspaceGridViewCellRects(3)).toEqual([
      { left: 0, top: 0, width: 50, height: 50 },
      { left: 50, top: 0, width: 50, height: 50 },
      { left: 0, top: 50, width: 100, height: 50 }
    ])
  })

  it('uses a two by two grid for four workspaces', () => {
    expect(computeWorkspaceGridViewCellRects(4).map((rect) => [rect.left, rect.top])).toEqual([
      [0, 0],
      [50, 0],
      [0, 50],
      [50, 50]
    ])
  })

  it.each([1, 2, 3, 4, 5, 6])('covers the whole workbench exactly once for %i cells', (count) => {
    expect(totalArea(count)).toBeCloseTo(100 * 100)
    for (const rect of computeWorkspaceGridViewCellRects(count)) {
      expect(rect.left + rect.width).toBeLessThanOrEqual(100 + 1e-9)
      expect(rect.top + rect.height).toBeLessThanOrEqual(100 + 1e-9)
    }
  })
})
