import { describe, expect, it } from 'vitest'
import { activeFamilyRootsFor } from './active-family-roots'
import { buildLineageRowProjection } from './lineage-row-projection'
import type { RenderRow } from './render-row'
import { makeWorktree } from '../../worktree-card-slot-fixture-seeds'

function item(id: string, depth: number, childCount = 0): RenderRow {
  return {
    type: 'item',
    rowKey: id,
    sectionKey: 'all',
    worktree: makeWorktree({ id, name: id, agents: [] }, 0),
    repo: undefined,
    depth,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: childCount
  }
}

// #50106: the family box paints the active parent's highlight, and the card's own surface
// fades in where the box was: one painter, whether the children are shown or hidden.
describe('active family roots', () => {
  const rows = [item('parent', 0, 1)]
  const projection = buildLineageRowProjection(rows, 'none', true)
  const roots = (activeWorktreeId: string) =>
    activeFamilyRootsFor({
      rows,
      projection,
      activeWorktreeId,
      activeWorkspaceExecutionHostId: null
    })

  it('keeps the box on an active parent whose children are hidden', () => {
    // The children are hidden, so no row sits below the parent: the box would go, and the
    // card's own surface would fade in where it was.
    expect([...roots('parent')]).toEqual([0])
  })

  it('leaves a workspace without children its own surface', () => {
    expect([...roots('other')]).toEqual([])
  })
})
