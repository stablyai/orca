import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('preserves folder click defaults and only suppresses a requested keyboard reveal', async () => {
    await activateWorktreeFromSidebar('folder:f', 'ssh:other')
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenLastCalledWith('f', {
      navigationIntent: 'user-open',
      executionHostId: 'ssh:other'
    })
    await activateWorktreeFromSidebar('folder:f', 'ssh:other', { revealInSidebar: false })
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenLastCalledWith('f', {
      navigationIntent: 'user-open',
      executionHostId: 'ssh:other',
      revealInSidebar: false
    })
  })

  it('switches immediately while an ephemeral runtime wake is pending', async () => {
    let resolveResume: ((value: null) => void) | undefined
    const resumeWorkspace = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveResume = resolve
        })
    )
    vi.stubGlobal('window', {
      api: { ephemeralVm: { resumeWorkspace } }
    })

    const activation = activateWorktreeFromSidebar('wt-vm')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-vm', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
    expect(resumeWorkspace).toHaveBeenCalledWith({ workspaceId: 'wt-vm' })

    resolveResume?.(null)
    await activation
  })
})
