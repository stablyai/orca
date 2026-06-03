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
    ptyIdsByTabId: {} as Record<string, string[]>,
    browserTabsByWorktree: {} as Record<string, { id: string }[]>,
    openFiles: [] as { worktreeId: string }[]
  }
  const activateAndRevealWorktree = vi.fn()
  const markInputQuietSchedulerInput = vi.fn()
  const pendingCallbacks: (() => void)[] = []
  const pendingCancels: ReturnType<typeof vi.fn>[] = []
  const scheduleAfterInputQuiet = vi.fn((callback: () => void) => {
    let cancelled = false
    const cancel = vi.fn(() => {
      cancelled = true
    })
    pendingCallbacks.push(() => {
      if (!cancelled) {
        callback()
      }
    })
    pendingCancels.push(cancel)
    return cancel
  })
  return {
    activateAndRevealWorktree,
    markInputQuietSchedulerInput,
    pendingCallbacks,
    pendingCancels,
    scheduleAfterInputQuiet,
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
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/input-quiet-scheduler', () => ({
  markInputQuietSchedulerInput: mocks.markInputQuietSchedulerInput,
  scheduleAfterInputQuiet: mocks.scheduleAfterInputQuiet
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import { runSleepWorktrees } from './sleep-worktree-flow'

describe('sleep flow vs queued slept-workspace activation', () => {
  beforeEach(() => {
    mocks.activateAndRevealWorktree.mockClear()
    mocks.markInputQuietSchedulerInput.mockClear()
    mocks.scheduleAfterInputQuiet.mockClear()
    mocks.pendingCallbacks.length = 0
    mocks.pendingCancels.length = 0
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
    mocks.state.browserTabsByWorktree = {}
    mocks.state.openFiles = []
  })

  it('does not let an old slept-parent activation fire after sleeping children', async () => {
    await runSleepWorktrees(['wt-parent'])

    expect(mocks.state.activeWorktreeId).toBeNull()
    expect(mocks.state.ptyIdsByTabId['tab-parent']).toEqual([])

    // A normal click on the slept parent row during selection setup queues a
    // wake internally, even though the user is just trying to select children.
    activateWorktreeFromSidebar('wt-parent')
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.pendingCallbacks).toHaveLength(1)

    await runSleepWorktrees(['wt-child-1', 'wt-child-2', 'wt-child-3'])
    mocks.pendingCallbacks[0]?.()

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.pendingCancels[0]).toHaveBeenCalledTimes(1)
  })
})
