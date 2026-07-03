import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const scheduledActivations: {
    callback: () => void | Promise<void>
    cancelled: boolean
    options: { delayMs: number; quietMs: number; idleTimeoutMs: number }
  }[] = []
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
  const resumeWorkspace = vi.fn().mockResolvedValue(null)
  return {
    activateAndRevealFolderWorkspace,
    activateAndRevealWorktree,
    resumeWorkspace,
    scheduledActivations,
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

vi.mock('@/lib/input-quiet-scheduler', () => ({
  scheduleAfterInputQuiet: vi.fn(
    (
      callback: () => void | Promise<void>,
      options: { delayMs: number; quietMs: number; idleTimeoutMs: number }
    ) => {
      const schedule = { callback, cancelled: false, options }
      mocks.scheduledActivations.push(schedule)
      return () => {
        schedule.cancelled = true
      }
    }
  )
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import {
  SIDEBAR_WORKTREE_ACTIVATION_DELAY_MS,
  SIDEBAR_WORKTREE_ACTIVATION_IDLE_TIMEOUT_MS,
  SIDEBAR_WORKTREE_ACTIVATION_INPUT_QUIET_MS,
  activateWorktreeFromSidebar
} from '@/lib/sidebar-worktree-activation'
import { runSleepWorktrees } from './sleep-worktree-flow'

function fireScheduledActivation(index = 0): void {
  const schedule = mocks.scheduledActivations[index]
  if (!schedule || schedule.cancelled) {
    return
  }
  schedule.callback()
}

async function settleScheduledActivation(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function runScheduledActivation(index = 0): Promise<void> {
  fireScheduledActivation(index)
  await settleScheduledActivation()
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

describe('sleep flow vs slept-workspace activation', () => {
  beforeEach(() => {
    mocks.activateAndRevealWorktree.mockClear()
    mocks.activateAndRevealFolderWorkspace.mockClear()
    mocks.resumeWorkspace.mockClear().mockResolvedValue(null)
    mocks.scheduledActivations = []
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
    expect(mocks.resumeWorkspace).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.scheduledActivations).toHaveLength(1)
    expect(mocks.scheduledActivations[0]?.options).toEqual({
      delayMs: SIDEBAR_WORKTREE_ACTIVATION_DELAY_MS,
      quietMs: SIDEBAR_WORKTREE_ACTIVATION_INPUT_QUIET_MS,
      idleTimeoutMs: SIDEBAR_WORKTREE_ACTIVATION_IDLE_TIMEOUT_MS
    })

    await runScheduledActivation()

    expect(mocks.resumeWorkspace).toHaveBeenCalledWith({ workspaceId: 'wt-parent' })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-parent', {
      revealInSidebar: false
    })

    await runSleepWorktrees(['wt-child-1', 'wt-child-2', 'wt-child-3'])

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
  })

  it('cancels an intermediate sidebar activation when another row is clicked', async () => {
    await activateWorktreeFromSidebar('wt-parent')
    const parentSchedule = mocks.scheduledActivations[0]

    await activateWorktreeFromSidebar('wt-child-1')

    expect(parentSchedule?.cancelled).toBe(true)
    await runScheduledActivation(0)
    expect(mocks.resumeWorkspace).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()

    await runScheduledActivation(1)

    expect(mocks.resumeWorkspace).toHaveBeenCalledWith({ workspaceId: 'wt-child-1' })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-child-1', {
      revealInSidebar: false
    })
  })

  it('cancels pending activation when the target worktree goes to sleep', async () => {
    await activateWorktreeFromSidebar('wt-parent')
    const parentSchedule = mocks.scheduledActivations[0]

    await runSleepWorktrees(['wt-parent'])
    await runScheduledActivation()

    expect(parentSchedule?.cancelled).toBe(true)
    expect(mocks.resumeWorkspace).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('ignores a resume that finishes after the target worktree goes to sleep', async () => {
    const resume = createDeferred<null>()
    mocks.resumeWorkspace.mockReturnValueOnce(resume.promise)

    await activateWorktreeFromSidebar('wt-parent')
    fireScheduledActivation()
    await Promise.resolve()
    expect(mocks.resumeWorkspace).toHaveBeenCalledWith({ workspaceId: 'wt-parent' })

    await runSleepWorktrees(['wt-parent'])
    resume.resolve(null)
    await settleScheduledActivation()

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not activate a slept worktree when VM resume fails', async () => {
    mocks.resumeWorkspace.mockRejectedValueOnce(new Error('provider unavailable'))

    await activateWorktreeFromSidebar('wt-parent')
    await runScheduledActivation()

    expect(mocks.resumeWorkspace).toHaveBeenCalledWith({ workspaceId: 'wt-parent' })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to wake ephemeral VM workspace',
      expect.objectContaining({ description: 'provider unavailable' })
    )
  })
})
