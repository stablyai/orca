import { describe, expect, it } from 'vitest'
import { buildWorktreeDragPreviewOffsets } from './worktree-drag-preview-offsets'

describe('virtualized workspace drag preview', () => {
  it('opens the full insertion space when the source and target have unmounted units between them', () => {
    const preview = buildWorktreeDragPreviewOffsets({
      groupIds: ['first', 'offscreen', 'picked'],
      draggedIds: ['picked'],
      draggingWorktreeId: 'picked',
      draggedPreviewHeight: 40,
      fallbackGap: 0,
      dropIndex: 0,
      rects: [
        { worktreeId: 'first', groupIndex: 0, top: 0, bottom: 100, layoutBottom: 106 },
        { worktreeId: 'picked', groupIndex: 2, top: 212, bottom: 312, layoutBottom: 318 }
      ]
    })
    expect(preview.offsets.get('first')).toBe(106)
    expect(preview.placeholderTop).toBe(0)
  })
})
