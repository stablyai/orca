import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    activeWorktreeId: null as string | null,
    setActiveWorktree: vi.fn((worktreeId: string | null) => {
      state.activeWorktreeId = worktreeId
    }),
    shutdownWorktreeBrowsers: vi.fn().mockResolvedValue(undefined),
    shutdownWorktreeTerminals: vi.fn(async (worktreeId: string) => {
      for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
        state.ptyIdsByTabId[tab.id] = []
      }
    }),
    repos: [] as { id: string; connectionId?: string | null; executionHostId?: string | null }[],
    settings: { activeRuntimeEnvironmentId: null as string | null },
    runtimeEnvironments: [] as { id: string; source?: 'manual' | 'ephemeral-vm' }[],
    worktreesByRepo: {} as Record<string, { id: string; repoId: string; hostId?: string }[]>,
    tabsByWorktree: {} as Record<string, { id: string }[]>,
    ptyIdsByTabId: {} as Record<string, string[]>
  }
  const activateAndRevealWorktree = vi.fn()
  const activateAndRevealFolderWorkspace = vi.fn()
  const resumeWorkspace = vi.fn().mockResolvedValue(null)
  return {
    activateAndRevealFolderWorkspace,
    activateAndRevealWorktree,
    resumeWorkspace,
    state,
    toastError: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import { runSleepWorktrees } from './sleep-worktree-flow'

describe('sleep flow vs slept-workspace activation', () => {
  beforeEach(() => {
    mocks.activateAndRevealWorktree.mockClear()
    mocks.activateAndRevealFolderWorkspace.mockClear()
    mocks.resumeWorkspace.mockClear().mockResolvedValue(null)
    mocks.toastError.mockClear()
    vi.stubGlobal('window', {
      api: {
        ephemeralVm: {
          resumeWorkspace: mocks.resumeWorkspace
        }
      }
    })
    mocks.state.activeWorktreeId = 'wt-parent'
    mocks.state.setActiveWorktree.mockClear()
    mocks.state.shutdownWorktreeBrowsers.mockClear().mockResolvedValue(undefined)
    mocks.state.shutdownWorktreeTerminals.mockClear().mockImplementation(async (worktreeId) => {
      for (const tab of mocks.state.tabsByWorktree[worktreeId] ?? []) {
        mocks.state.ptyIdsByTabId[tab.id] = []
      }
    })
    mocks.state.repos = [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }]
    mocks.state.settings = { activeRuntimeEnvironmentId: null }
    mocks.state.runtimeEnvironments = [{ id: 'vm-env', source: 'ephemeral-vm' }]
    mocks.state.worktreesByRepo = {
      'repo-1': [
        { id: 'wt-parent', repoId: 'repo-1', hostId: 'runtime:vm-env' },
        { id: 'wt-child-1', repoId: 'repo-1', hostId: 'runtime:vm-env' },
        { id: 'wt-child-2', repoId: 'repo-1', hostId: 'runtime:vm-env' },
        { id: 'wt-child-3', repoId: 'repo-1', hostId: 'runtime:vm-env' }
      ]
    }
    mocks.state.tabsByWorktree = {
      'wt-parent': [{ id: 'tab-parent' }],
      'wt-child-1': [{ id: 'tab-child-1' }],
      'wt-child-2': [{ id: 'tab-child-2' }],
      'wt-child-3': [{ id: 'tab-child-3' }]
    }
    mocks.state.ptyIdsByTabId = {
      'tab-parent': ['pty-parent'],
      'tab-child-1': ['pty-child-1'],
      'tab-child-2': ['pty-child-2'],
      'tab-child-3': ['pty-child-3']
    }
  })

  it('does not leave behind a delayed parent activation after sleeping children', async () => {
    await runSleepWorktrees(['wt-parent'])

    expect(mocks.state.activeWorktreeId).toBeNull()
    expect(mocks.state.ptyIdsByTabId['tab-parent']).toEqual([])

    await activateWorktreeFromSidebar('wt-parent')
    expect(mocks.resumeWorkspace).toHaveBeenCalledWith({ workspaceId: 'wt-parent' })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-parent', {
      revealInSidebar: false
    })

    await runSleepWorktrees(['wt-child-1', 'wt-child-2', 'wt-child-3'])

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
  })

  it('activates a local worktree without a VM resume round trip', async () => {
    mocks.state.worktreesByRepo = {
      'repo-1': [{ id: 'wt-local', repoId: 'repo-1', hostId: 'local' }]
    }

    await activateWorktreeFromSidebar('wt-local')

    expect(mocks.resumeWorkspace).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-local', {
      revealInSidebar: false
    })
  })

  it('activates a user-managed runtime worktree without a VM resume round trip', async () => {
    mocks.state.runtimeEnvironments = [{ id: 'manual-env', source: 'manual' }]
    mocks.state.worktreesByRepo = {
      'repo-1': [{ id: 'wt-manual', repoId: 'repo-1', hostId: 'runtime:manual-env' }]
    }

    await activateWorktreeFromSidebar('wt-manual')

    expect(mocks.resumeWorkspace).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-manual', {
      revealInSidebar: false
    })
  })

  it('does not activate a slept worktree when VM resume fails', async () => {
    mocks.resumeWorkspace.mockRejectedValueOnce(new Error('provider unavailable'))

    await activateWorktreeFromSidebar('wt-parent')

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to wake ephemeral VM workspace',
      expect.objectContaining({ description: 'provider unavailable' })
    )
  })
})
