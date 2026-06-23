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
    tabsByWorktree: {} as Record<string, { id: string }[]>,
    ptyIdsByTabId: {} as Record<string, string[]>
  }
  const activateAndRevealWorktree = vi.fn()
  const activateAndRevealFolderWorkspace = vi.fn()
  return {
    activateAndRevealFolderWorkspace,
    activateAndRevealWorktree,
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
    mocks.toastError.mockClear()
    mocks.state.activeWorktreeId = 'wt-parent'
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
    await runSleepWorktrees(['wt-parent'])

    expect(mocks.state.activeWorktreeId).toBeNull()
    expect(mocks.state.ptyIdsByTabId['tab-parent']).toEqual([])

    activateWorktreeFromSidebar('wt-parent')
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-parent', {
      revealInSidebar: false
    })

    await runSleepWorktrees(['wt-child-1', 'wt-child-2', 'wt-child-3'])

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
  })
})
