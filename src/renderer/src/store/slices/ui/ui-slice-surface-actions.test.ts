import { describe, expect, it, beforeEach } from 'vitest'
import { useAppStore } from '../../index'

describe('workspace port-scan surface actions', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePortScanRefreshing: false })
  })

  // Why a listener count and not a state assertion: zustand notifies on identity, so an
  // unconditional `set` is invisible in the resulting state yet re-runs every selector.
  const countNotifications = (run: () => void): number => {
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => {
      notifications += 1
    })
    try {
      run()
    } finally {
      unsubscribe()
    }
    return notifications
  }

  it('does not notify subscribers when the refreshing flag is unchanged', () => {
    const setRefreshing = useAppStore.getState().setWorkspacePortScanRefreshing

    expect(countNotifications(() => setRefreshing(false))).toBe(0)
    expect(countNotifications(() => setRefreshing(false))).toBe(0)
    expect(useAppStore.getState().workspacePortScanRefreshing).toBe(false)
  })

  it('still notifies once on a real transition, in both directions', () => {
    const setRefreshing = useAppStore.getState().setWorkspacePortScanRefreshing

    expect(countNotifications(() => setRefreshing(true))).toBe(1)
    expect(useAppStore.getState().workspacePortScanRefreshing).toBe(true)
    expect(countNotifications(() => setRefreshing(false))).toBe(1)
    expect(useAppStore.getState().workspacePortScanRefreshing).toBe(false)
  })
})

describe('sidebar reveal ownership', () => {
  beforeEach(() => {
    useAppStore.setState({ pendingRevealWorktree: null, pendingRevealSidebarRow: null })
  })

  it('replaces a worktree destination with the newer sidebar row request', () => {
    const state = useAppStore.getState()
    state.revealWorktreeInSidebar('old', { beginRename: true })
    state.revealSidebarRow('folder:new', { behavior: 'smooth' })
    expect(useAppStore.getState().pendingRevealWorktree).toBeNull()
    expect(useAppStore.getState().pendingRevealSidebarRow?.rowKey).toBe('folder:new')
  })

  it('replaces a sidebar row destination with a host-qualified worktree request', () => {
    const state = useAppStore.getState()
    state.revealSidebarRow('repo:old')
    state.revealWorktreeInSidebar('new', { executionHostId: 'ssh:host-a', beginRename: true })
    expect(useAppStore.getState().pendingRevealSidebarRow).toBeNull()
    expect(useAppStore.getState().pendingRevealWorktree).toMatchObject({
      worktreeId: 'new',
      executionHostId: 'ssh:host-a',
      beginRename: true
    })
  })

  it('gives repeated same-id requests distinct authority, including across hosts', () => {
    const state = useAppStore.getState()
    state.revealWorktreeInSidebar('same', { executionHostId: 'ssh:host-a' })
    const first = useAppStore.getState().pendingRevealWorktree
    state.revealWorktreeInSidebar('same', { executionHostId: 'ssh:host-a' })
    const second = useAppStore.getState().pendingRevealWorktree
    expect(second).not.toBe(first)
    state.revealWorktreeInSidebar('same', { executionHostId: 'ssh:host-b' })
    expect(useAppStore.getState().pendingRevealWorktree).not.toBe(second)
    expect(useAppStore.getState().pendingRevealWorktree?.executionHostId).toBe('ssh:host-b')
  })
})
