import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  wakeMachineForHost: vi.fn(),
  hasMachineProviders: vi.fn(() => false)
}))

vi.mock('@/lib/machines/machine-wake-on-open', () => ({
  wakeMachineForHost: mocks.wakeMachineForHost
}))
vi.mock('@/store/machines', () => ({ hasMachineProviders: mocks.hasMachineProviders }))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

import { useAppStore } from '@/store'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { activateWorktreeFromSidebar } from './sidebar-worktree-activation'

describe('sidebar worktree activation', () => {
  beforeEach(() => {
    mocks.activateAndRevealWorktree.mockClear()
    mocks.activateAndRevealFolderWorkspace.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('activates a clicked worktree without sidebar reveal', async () => {
    await activateWorktreeFromSidebar('wt-live')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-live', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
  })

  it('does not defer non-VM slept worktree selection behind terminal wake work', async () => {
    await activateWorktreeFromSidebar('wt-slept')

    // Why: setActiveWorktree already defers terminal prep where needed. The
    // sidebar click itself must switch app state immediately.
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-slept', {
      navigationIntent: 'user-open',
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

  it('routes folder workspace activation through the guarded folder path', async () => {
    await activateWorktreeFromSidebar('folder:folder-workspace-1')

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      navigationIntent: 'user-open'
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('wakes the machine behind a folder workspace from the folder’s own host', async () => {
    mocks.hasMachineProviders.mockReturnValueOnce(true)
    const folder: FolderWorkspace = {
      id: 'folder-workspace-2',
      projectGroupId: 'group-1',
      name: 'Notes',
      folderPath: '/home/dev/notes',
      executionHostId: 'ssh:machine-a',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    useAppStore.setState({ folderWorkspaces: [folder], projectGroups: [] })

    await activateWorktreeFromSidebar('folder:folder-workspace-2')

    expect(mocks.wakeMachineForHost).toHaveBeenCalledWith(
      'ssh:machine-a',
      'folder:folder-workspace-2'
    )
  })

  it('marks the machine wake before navigation mounts the worktree’s terminals', async () => {
    mocks.hasMachineProviders.mockReturnValueOnce(true)
    const order: string[] = []
    mocks.wakeMachineForHost.mockImplementationOnce(async () => {
      order.push('wake')
    })
    mocks.activateAndRevealWorktree.mockImplementationOnce(() => order.push('activate'))

    await activateWorktreeFromSidebar('wt-machine', 'ssh:machine-a')

    expect(mocks.wakeMachineForHost).toHaveBeenCalledWith('ssh:machine-a', 'wt-machine')
    expect(order).toEqual(['wake', 'activate'])
  })
})
