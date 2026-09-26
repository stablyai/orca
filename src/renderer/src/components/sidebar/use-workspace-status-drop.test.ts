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

  it('passes host-qualified pin targets through document drops', () => {
    const pinMany = vi.fn()
    const targets = [{ worktreeId: 'shared', executionHostId: 'ssh:host-b' as const }]

    commitWorkspaceStatusDocumentDrop({
      worktreeIds: ['shared'],
      pinTargets: targets,
      status: null,
      isPinDrop: true,
      onMoveWorktreeToStatus: vi.fn(),
      onPinWorktree: vi.fn(),
      onPinWorktrees: pinMany
    })

    expect(pinMany).toHaveBeenCalledWith(targets)
  })

  it('does not fall back to bare ids when qualified pin targets are unavailable', () => {
    const pinMany = vi.fn()

    commitWorkspaceStatusDocumentDrop({
      worktreeIds: ['shared'],
      pinTargets: [],
      status: null,
      isPinDrop: true,
      onMoveWorktreeToStatus: vi.fn(),
      onPinWorktree: vi.fn(),
      onPinWorktrees: pinMany
    })

    expect(pinMany).not.toHaveBeenCalled()
  })
})
