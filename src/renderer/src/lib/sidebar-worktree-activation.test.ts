import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    sleptWorktreeIds: {} as Record<string, true>,
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
    state
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

import {
  activateWorktreeFromSidebar,
  cancelPendingSidebarWorktreeActivation
} from './sidebar-worktree-activation'

describe('sidebar worktree activation', () => {
  beforeEach(() => {
    cancelPendingSidebarWorktreeActivation()
    mocks.activateAndRevealWorktree.mockClear()
    mocks.markInputQuietSchedulerInput.mockClear()
    mocks.scheduleAfterInputQuiet.mockClear()
    mocks.pendingCallbacks.length = 0
    mocks.pendingCancels.length = 0
    mocks.state.sleptWorktreeIds = {}
    mocks.state.tabsByWorktree = {}
    mocks.state.ptyIdsByTabId = {}
    mocks.state.browserTabsByWorktree = {}
    mocks.state.openFiles = []
  })

  it('cancels a queued slept-workspace activation', () => {
    mocks.state.sleptWorktreeIds = { 'wt-parent': true }

    activateWorktreeFromSidebar('wt-parent')
    cancelPendingSidebarWorktreeActivation()

    expect(mocks.pendingCancels[0]).toHaveBeenCalledTimes(1)
    mocks.pendingCallbacks[0]?.()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not defer an unslept workspace even when it has no live PTY', () => {
    mocks.state.tabsByWorktree = { 'wt-unslept': [{ id: 'tab-1' }] }
    mocks.state.ptyIdsByTabId = { 'tab-1': [] }

    activateWorktreeFromSidebar('wt-unslept')

    expect(mocks.scheduleAfterInputQuiet).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-unslept')
  })
})
