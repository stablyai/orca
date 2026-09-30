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
