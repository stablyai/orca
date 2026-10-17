import { beforeEach, describe, expect, it, vi } from 'vitest'

type ActivationTestState = {
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: string | null
  setActiveWorktree: ReturnType<typeof vi.fn>
  shutdownWorktreeBrowsers: ReturnType<typeof vi.fn>
  shutdownWorktreeTerminals: ReturnType<typeof vi.fn>
  unifiedTabsByWorktree: Record<string, unknown[]>
  tabsByWorktree: Record<string, { id: string }[]>
  ptyIdsByTabId: Record<string, string[]>
}

const mocks = vi.hoisted(() => {
  const state: ActivationTestState = {
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: 'local',
    setActiveWorktree: vi.fn((worktreeId: string | null) => {
      state.activeWorktreeId = worktreeId
      if (!worktreeId) {
        state.activeWorkspaceExecutionHostId = null
      }
    }),
    shutdownWorktreeBrowsers: vi.fn().mockResolvedValue(undefined),
    shutdownWorktreeTerminals: vi.fn(async (worktreeId: string) => {
      for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
        state.ptyIdsByTabId[tab.id] = []
      }
    }),
    unifiedTabsByWorktree: {},
    tabsByWorktree: {},
    ptyIdsByTabId: {}
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
    getState: () => mocks.state,
    subscribe: () => () => {}
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionTargetForHost: () => ({ kind: 'local' })
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: async () => ({ stoppedSessionIds: [] })
}))

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
    mocks.state.activeWorkspaceExecutionHostId = 'local'
    mocks.state.setActiveWorktree.mockClear()
    mocks.state.shutdownWorktreeBrowsers.mockClear().mockResolvedValue(undefined)
    mocks.state.shutdownWorktreeTerminals.mockClear().mockImplementation(async (worktreeId) => {
      for (const tab of mocks.state.tabsByWorktree[worktreeId] ?? []) {
        mocks.state.ptyIdsByTabId[tab.id] = []
      }
    })
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
    await runSleepWorktrees([{ id: 'wt-parent', executionHostId: 'local' }])

    expect(mocks.state.activeWorktreeId).toBeNull()
    expect(mocks.state.ptyIdsByTabId['tab-parent']).toEqual([])

    await activateWorktreeFromSidebar('wt-parent')
    expect(mocks.resumeWorkspace).toHaveBeenCalledWith({ workspaceId: 'wt-parent' })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-parent', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })

    await runSleepWorktrees(
      ['wt-child-1', 'wt-child-2', 'wt-child-3'].map((id) => ({
        id,
        executionHostId: 'local'
      }))
    )

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
  })

  it('keeps the slept worktree selected when VM resume fails', async () => {
    mocks.resumeWorkspace.mockRejectedValueOnce(new Error('provider unavailable'))

    await activateWorktreeFromSidebar('wt-parent')

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-parent', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to wake ephemeral VM workspace',
      expect.objectContaining({ description: 'provider unavailable' })
    )
  })
})
