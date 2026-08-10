import { describe, expect, it } from 'vitest'
import { shouldStartWorkspaceBoardDragPreview } from './workspace-board-drag-preview-intent'

describe('workspace board drag preview intent', () => {
  it('keeps vertical sidebar reorders from mounting the board preview', () => {
    expect(
      shouldStartWorkspaceBoardDragPreview({
        pointerX: 132,
        startX: 96,
        sidebarRight: 285
      })
    ).toBe(false)
  })

  it('starts the preview after a rightward drag reaches the sidebar edge zone', () => {
    expect(
      shouldStartWorkspaceBoardDragPreview({
        pointerX: 252,
        startX: 96,
        sidebarRight: 285
      })
    ).toBe(true)
  })

  it('ignores the edge zone until the drag moves right far enough', () => {
    expect(
      shouldStartWorkspaceBoardDragPreview({
        pointerX: 252,
        startX: 242,
        sidebarRight: 285
      })
    ).toBe(false)
  })

  it('accepts a deliberate rightward drag beyond the sidebar edge', () => {
    expect(
      shouldStartWorkspaceBoardDragPreview({
        pointerX: 310,
        startX: 260,
        sidebarRight: 285
      })
    ).toBe(true)
  })
})
