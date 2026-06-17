import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    tabsByWorktree: {} as Record<string, { id: string }[]>,
    ptyIdsByTabId: {} as Record<string, string[]>,
    browserTabsByWorktree: {} as Record<string, { id: string }[]>,
    openFiles: [] as { worktreeId: string }[]
  }
  const activateAndRevealWorktree = vi.fn()
  const activateAndRevealFolderWorkspace = vi.fn()
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
    activateAndRevealFolderWorkspace,
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
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace,
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
    delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    cancelPendingSidebarWorktreeActivation()
    mocks.activateAndRevealWorktree.mockClear()
    mocks.activateAndRevealFolderWorkspace.mockClear()
    mocks.markInputQuietSchedulerInput.mockClear()
    mocks.scheduleAfterInputQuiet.mockClear()
    mocks.pendingCallbacks.length = 0
    mocks.pendingCancels.length = 0
    mocks.state.tabsByWorktree = {}
    mocks.state.ptyIdsByTabId = {}
    mocks.state.browserTabsByWorktree = {}
    mocks.state.openFiles = []
  })

  it('cancels a queued slept-workspace activation', () => {
    mocks.state.tabsByWorktree = { 'wt-parent': [{ id: 'tab-1' }] }
    mocks.state.ptyIdsByTabId = { 'tab-1': [] }

    activateWorktreeFromSidebar('wt-parent')
    cancelPendingSidebarWorktreeActivation()

    expect(mocks.pendingCancels[0]).toHaveBeenCalledTimes(1)
    mocks.pendingCallbacks[0]?.()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not defer a workspace with a live PTY', () => {
    mocks.state.tabsByWorktree = { 'wt-live': [{ id: 'tab-1' }] }
    mocks.state.ptyIdsByTabId = { 'tab-1': ['pty-1'] }

    activateWorktreeFromSidebar('wt-live')

    expect(mocks.scheduleAfterInputQuiet).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-live', {
      revealInSidebar: false
    })
  })

  it('routes folder workspace activation through the guarded folder path', () => {
    activateWorktreeFromSidebar('folder:folder-workspace-1')

    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1')
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.scheduleAfterInputQuiet).not.toHaveBeenCalled()
  })

  it('does not defer slept workspace activation in the web client', () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    mocks.state.tabsByWorktree = { 'wt-web-slept': [{ id: 'tab-1' }] }
    mocks.state.ptyIdsByTabId = { 'tab-1': [] }

    activateWorktreeFromSidebar('wt-web-slept')

    expect(mocks.scheduleAfterInputQuiet).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-web-slept', {
      revealInSidebar: false
    })
  })
})
