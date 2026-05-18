import { describe, expect, it, vi } from 'vitest'
import { commitWorkspaceStatusDocumentDrop } from './use-workspace-status-drop'

describe('workspace status document drop', () => {
  it('commits multi-worktree status drops through the batched callback once', () => {
    const moveOne = vi.fn()
    const moveMany = vi.fn()
    const pinOne = vi.fn()

    commitWorkspaceStatusDocumentDrop({
      worktreeIds: ['wt-1', 'wt-2', 'wt-3'],
      status: 'in-review',
      isPinDrop: false,
      onMoveWorktreeToStatus: moveOne,
      onMoveWorktreesToStatus: moveMany,
      onPinWorktree: pinOne
    })

    expect(moveMany).toHaveBeenCalledWith(['wt-1', 'wt-2', 'wt-3'], 'in-review')
    expect(moveMany).toHaveBeenCalledTimes(1)
    expect(moveOne).not.toHaveBeenCalled()
    expect(pinOne).not.toHaveBeenCalled()
  })

  it('commits multi-worktree pin drops through the batched callback once', () => {
    const moveOne = vi.fn()
    const pinOne = vi.fn()
    const pinMany = vi.fn()

    commitWorkspaceStatusDocumentDrop({
      worktreeIds: ['wt-1', 'wt-2'],
      status: null,
      isPinDrop: true,
      onMoveWorktreeToStatus: moveOne,
      onPinWorktree: pinOne,
      onPinWorktrees: pinMany
    })

    expect(pinMany).toHaveBeenCalledWith(['wt-1', 'wt-2'])
    expect(pinMany).toHaveBeenCalledTimes(1)
    expect(pinOne).not.toHaveBeenCalled()
    expect(moveOne).not.toHaveBeenCalled()
  })
})
