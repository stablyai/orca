import { describe, expect, it } from 'vitest'
import { shouldStartWorkspaceBoardDragPreview } from './workspace-board-drag-preview-intent'

describe('workspace board drag preview intent', () => {
  it('does not start the expensive board preview for small sidebar reorder drags', () => {
    expect(
      shouldStartWorkspaceBoardDragPreview({
        pointerX: 132,
        startX: 96,
        sidebarRight: 285
      })
    ).toBe(false)
  })

  it('starts the board preview after a rightward drag reaches the sidebar edge zone', () => {
    expect(
      shouldStartWorkspaceBoardDragPreview({
        pointerX: 252,
        startX: 96,
        sidebarRight: 285
      })
    ).toBe(true)
  })

  it('ignores edge-zone drags that did not move right enough to signal board intent', () => {
    expect(
      shouldStartWorkspaceBoardDragPreview({
        pointerX: 252,
        startX: 242,
        sidebarRight: 285
      })
    ).toBe(false)
  })
})
