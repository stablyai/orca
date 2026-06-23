import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

import { activateWorktreeFromSidebar } from './sidebar-worktree-activation'

describe('sidebar worktree activation', () => {
  beforeEach(() => {
    mocks.activateAndRevealWorktree.mockClear()
    mocks.activateAndRevealFolderWorkspace.mockClear()
  })

  it('activates a clicked worktree immediately without sidebar reveal', () => {
    activateWorktreeFromSidebar('wt-live')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-live', {
      revealInSidebar: false
    })
    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
  })

  it('does not defer slept worktree selection behind terminal wake work', () => {
    activateWorktreeFromSidebar('wt-slept')

    // Why: setActiveWorktree already defers terminal prep where needed. The
    // sidebar click itself must switch app state immediately.
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-slept', {
      revealInSidebar: false
    })
  })

  it('routes folder workspace activation through the guarded folder path', () => {
    activateWorktreeFromSidebar('folder:folder-workspace-1')

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1')
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
