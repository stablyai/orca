import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { WorkspaceSleepNotice } from '../../../../../../shared/workspace-sleep'

type Selection = { activeWorktreeId: string | null; activeWorkspaceExecutionHostId: null }

const mocks = vi.hoisted(() => {
  const listeners = new Set<(state: Selection) => void>()
  const selection: Selection = { activeWorktreeId: null, activeWorkspaceExecutionHostId: null }
  const notify = (): void => {
    for (const listener of Array.from(listeners)) {
      listener({ ...selection })
    }
  }
  const setActiveWorktree = vi.fn((worktreeId: string | null) => {
    selection.activeWorktreeId = worktreeId
    notify()
    return true
  })
  return {
    listeners,
    selection,
    notify,
    setActiveWorktree,
    shutdownWorktreeBrowsers: vi.fn(),
    shutdownWorktreeTerminals: vi.fn<AppState['shutdownWorktreeTerminals']>(),
    notePredictiveWakeSlept: vi.fn(),
    activateWorktreeFromSidebar: vi.fn(async () => ({ ok: true })),
    cloudIds: new Set<string>()
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...mocks.selection,
      setActiveWorktree: mocks.setActiveWorktree,
      shutdownWorktreeBrowsers: mocks.shutdownWorktreeBrowsers,
      shutdownWorktreeTerminals: mocks.shutdownWorktreeTerminals
    }),
    subscribe: (listener: (state: Selection) => void) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
}))
vi.mock('@/lib/orca-cloud/orca-cloud-workspace-store', () => ({
  getCloudWorkspaceSnapshot: () => ({ ids: mocks.cloudIds })
}))
vi.mock('@/lib/orca-cloud/cloud-predictive-wake', () => ({
  notePredictiveWakeSlept: mocks.notePredictiveWakeSlept
}))
vi.mock('./sleep-worktree-sidebar-position', () => ({
  preserveSidebarWorktreePosition: () => () => {}
}))
vi.mock('./sleep-worktree-flow', () => ({ toastWorkspaceSleepOutcome: vi.fn() }))
vi.mock('@/lib/workspace/activation/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: mocks.activateWorktreeFromSidebar
}))
vi.mock('./browser-tab-sleep', () => ({
  sleepWorktreeBrowserTabs: vi.fn(),
  wakeWorktreeBrowserTabs: vi.fn()
}))

import { followWorkspaceSleep, keepWorkspaceAwakeDuringSleep } from './workspace-sleep-follower'
import { forgetWorktreeSleepIntent, hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import {
  holdWorktreeSleepView,
  isWorktreeGoingToSleep,
  isWorktreeSuspendCommitted,
  isWorktreeSleepViewHeld,
  releaseWorktreeSleepView,
  resetWorktreeSleepViewForTests
} from '@/lib/worktree-sleep-view'

const CLOUD = 'cloud-wt'
const sleepReopened = vi.fn(async () => {})
const resumeWorkspace = vi.fn()

function started(worktreeId = CLOUD, projectMovePauseId?: string): void {
  const notice: WorkspaceSleepNotice = projectMovePauseId
    ? { worktreeId, phase: 'started', projectMovePauseId }
    : { worktreeId, phase: 'started' }
  followWorkspaceSleep(notice)
}

async function ended(slept: boolean, worktreeId = CLOUD): Promise<void> {
  await followWorkspaceSleep({
    worktreeId,
    phase: 'ended',
    slept,
    stoppedPtyIds: slept ? ['pty-1'] : [],
    records: null
  })
}

/** The reopen note goes out on a microtask. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function select(worktreeId: string | null): void {
  mocks.setActiveWorktree(worktreeId)
  mocks.setActiveWorktree.mockClear()
}

describe('sleeping the workspace on screen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners.clear()
    mocks.cloudIds.clear()
    mocks.cloudIds.add(CLOUD)
    mocks.shutdownWorktreeTerminals.mockImplementation(async (_id, options) => {
      await options?.hostStop
    })
    vi.stubGlobal('window', {
      api: { worktrees: { sleepReopened }, ephemeralVm: { resumeWorkspace } }
    })
    select(CLOUD)
  })

  afterEach(() => {
    resetWorktreeSleepViewForTests()
    forgetWorktreeSleepIntent(CLOUD)
    forgetWorktreeSleepIntent('local-wt')
    vi.unstubAllGlobals()
  })

  it('keeps an Orca Cloud workspace selected and view-only, without waking it', async () => {
    started()
    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
    expect(mocks.selection.activeWorktreeId).toBe(CLOUD)
    expect(isWorktreeSleepViewHeld(CLOUD)).toBe(true)
    expect(isWorktreeGoingToSleep(CLOUD)).toBe(true)
    expect(mocks.notePredictiveWakeSlept).toHaveBeenCalledWith(CLOUD)
    // Unrelated store changes while it stays on screen are not a reopen.
    mocks.notify()
    await ended(true)
    await flush()
    expect(isWorktreeGoingToSleep(CLOUD)).toBe(false)
    expect(isWorktreeSleepViewHeld(CLOUD)).toBe(true)
    // Its panes keep waiting for a wake: being shown is not one.
    expect(hasWorktreeSleepIntent(CLOUD)).toBe(true)
    expect(sleepReopened).not.toHaveBeenCalled()
    expect(resumeWorkspace).not.toHaveBeenCalled()
    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
    expect(mocks.activateWorktreeFromSidebar).not.toHaveBeenCalled()
  })

  it('still leaves for Home when the workspace is not on Orca Cloud', async () => {
    select('local-wt')
    started('local-wt')
    expect(mocks.setActiveWorktree).toHaveBeenCalledWith(null)
    expect(isWorktreeSleepViewHeld('local-wt')).toBe(false)
    await ended(true, 'local-wt')
  })

  it('still leaves for Home when a project move pauses it', async () => {
    started(CLOUD, 'move-1')
    expect(mocks.setActiveWorktree).toHaveBeenCalledWith(null)
    expect(isWorktreeSleepViewHeld(CLOUD)).toBe(false)
    await ended(true)
  })

  it('does not pull back a user who chose another workspace, even when the sleep fails', async () => {
    started()
    select('other-wt')
    expect(isWorktreeSleepViewHeld(CLOUD)).toBe(false)
    await ended(false)
    await flush()
    expect(mocks.selection.activeWorktreeId).toBe('other-wt')
    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
    expect(sleepReopened).not.toHaveBeenCalled()
  })

  it('tells main when the user comes back before the sleep ends', async () => {
    started()
    select('other-wt')
    select(CLOUD)
    await flush()
    expect(sleepReopened).toHaveBeenCalledTimes(1)
    expect(sleepReopened).toHaveBeenCalledWith(CLOUD)
    await ended(true)
    // Reopened: it is the user's again, so its panes may connect.
    expect(hasWorktreeSleepIntent(CLOUD)).toBe(false)
  })

  it('tells main when the user wakes it from the view before the sleep ends', async () => {
    started()
    releaseWorktreeSleepView(CLOUD)
    await flush()
    expect(sleepReopened).toHaveBeenCalledTimes(1)
    await ended(true)
  })

  it('restores the awake workspace when the sleep fails', async () => {
    started()
    await ended(false)
    expect(isWorktreeSleepViewHeld(CLOUD)).toBe(false)
    expect(isWorktreeGoingToSleep(CLOUD)).toBe(false)
    expect(hasWorktreeSleepIntent(CLOUD)).toBe(false)
    // Re-activated in place, which respawns its stopped panes.
    expect(mocks.setActiveWorktree).toHaveBeenCalledWith(CLOUD)
    await flush()
    expect(sleepReopened).not.toHaveBeenCalled()
    expect(resumeWorkspace).not.toHaveBeenCalled()
  })

  it('Keep awake during the sleep tells main once, ends the hold, and leaves it awake', async () => {
    started()
    keepWorkspaceAwakeDuringSleep(CLOUD)
    expect(isWorktreeSleepViewHeld(CLOUD)).toBe(false)
    expect(isWorktreeGoingToSleep(CLOUD)).toBe(false)
    mocks.notify()
    await flush()
    expect(sleepReopened).toHaveBeenCalledTimes(1)
    expect(sleepReopened).toHaveBeenCalledWith(CLOUD)
    await ended(true)
    await flush()
    expect(sleepReopened).toHaveBeenCalledTimes(1)
    expect(mocks.selection.activeWorktreeId).toBe(CLOUD)
    // Awake again: opened the ordinary way, which wakes the sandbox if main had already suspended it.
    expect(hasWorktreeSleepIntent(CLOUD)).toBe(false)
    expect(mocks.activateWorktreeFromSidebar).toHaveBeenCalledWith(CLOUD)
  })

  it('Keep awake before main starts the sleep: stays selected and awake, never held', async () => {
    holdWorktreeSleepView(CLOUD)
    keepWorkspaceAwakeDuringSleep(CLOUD)
    started()
    expect(isWorktreeSleepViewHeld(CLOUD)).toBe(false)
    expect(isWorktreeGoingToSleep(CLOUD)).toBe(false)
    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
    mocks.notify()
    await flush()
    // Once at the click, and again when main starts the sleep (its reopen baseline is read then).
    expect(sleepReopened).toHaveBeenCalledTimes(2)
    await ended(true)
    await flush()
    expect(sleepReopened).toHaveBeenCalledTimes(2)
    expect(hasWorktreeSleepIntent(CLOUD)).toBe(false)
    expect(mocks.activateWorktreeFromSidebar).toHaveBeenCalledWith(CLOUD)
  })

  it('marks the suspend committed when main says so, and clears it when the sleep ends', async () => {
    started()
    expect(isWorktreeSuspendCommitted(CLOUD)).toBe(false)
    followWorkspaceSleep({ worktreeId: CLOUD, phase: 'suspending' })
    expect(isWorktreeSuspendCommitted(CLOUD)).toBe(true)
    // Never a reopen, never a wake: it only stops offering Keep awake.
    expect(sleepReopened).not.toHaveBeenCalled()
    await ended(true)
    expect(isWorktreeSuspendCommitted(CLOUD)).toBe(false)
  })
})
