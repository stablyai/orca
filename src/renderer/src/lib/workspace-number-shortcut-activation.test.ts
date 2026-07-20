import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

import { activateWorkspaceNumberShortcut } from './workspace-number-shortcut-activation'

describe('workspace number shortcut activation', () => {
  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockClear()
    mocks.activateAndRevealWorktree.mockClear()
  })

  it('routes folder workspace keys through folder activation', () => {
    activateWorkspaceNumberShortcut('folder:folder-1')

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-1')
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('keeps bare worktree ids on the existing activation path', () => {
    activateWorkspaceNumberShortcut('worktree-1')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('worktree-1')
    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
  })
})
