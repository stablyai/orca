import { describe, expect, it } from 'vitest'
import {
  applyWorktreeDropPreview,
  applyWorktreeLineageDropPreview,
  clearWorktreeDropPreview,
  WORKTREE_ROW_DRAG_INITIAL_STATE
} from './row-state'

const reorderPreview = {
  dropAnchorId: 'parent',
  dropIndex: 2,
  dropIndicatorY: 180,
  previewOffsetsByWorktreeId: new Map([['parent', -60]])
}

function reorderedState() {
  return applyWorktreeDropPreview(
    { ...WORKTREE_ROW_DRAG_INITIAL_STATE, draggingWorktreeId: 'child' },
    reorderPreview,
    { pointerY: 150, matchPointerY: true }
  )
}

describe('lineage drop preview', () => {
  it('keeps the hovered card in place while replacing the reorder line with nesting', () => {
    const before = reorderedState()
    const nesting = applyWorktreeLineageDropPreview(before, 'parent', 150)
    expect(nesting.previewOffsetsByWorktreeId).toBe(before.previewOffsetsByWorktreeId)
    expect(nesting.dropIndex).toBeNull()
    expect(nesting.dropIndicatorY).toBeNull()
    expect(nesting.lineageDropTargetId).toBe('parent')
    expect(applyWorktreeLineageDropPreview(nesting, 'parent', 150)).toBe(nesting)
  })

  it('repaints a target change even when the pointer stays at the same height', () => {
    const before = applyWorktreeLineageDropPreview(reorderedState(), 'parent', 150)
    const after = applyWorktreeLineageDropPreview(before, 'other-parent', 150)
    expect(after).not.toBe(before)
    expect(after.lineageDropTargetId).toBe('other-parent')
  })

  it('clears nesting feedback when returning to a reorder edge at the same height', () => {
    const before = applyWorktreeLineageDropPreview(reorderedState(), 'parent', 150)
    const after = applyWorktreeDropPreview(before, reorderPreview, {
      pointerY: 150,
      matchPointerY: true
    })
    expect(after.lineageDropTargetId).toBeNull()
    expect(after.dropIndicatorY).toBe(180)
  })

  it('clears nesting when leaving the sidebar even without pointer Y movement or offsets', () => {
    const before = applyWorktreeLineageDropPreview(WORKTREE_ROW_DRAG_INITIAL_STATE, 'parent', 150)
    const after = clearWorktreeDropPreview(before, { pointerY: 150, matchPointerY: true })
    expect(after).not.toBe(before)
    expect(after.lineageDropTargetId).toBeNull()
    expect(after.previewOffsetsByWorktreeId.size).toBe(0)
  })
})
