import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  collectTerminalProviderSnapshotPtyIds,
  synchronizeTerminalProviderSnapshotCapabilities
} from './terminal-provider-snapshot-capability'

export function useTerminalProviderSnapshotCapability(enabled: boolean): void {
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((state) => state.ptyIdsByTabId)
  const boundPtyIds = useMemo(
    () => collectTerminalProviderSnapshotPtyIds({ tabsByWorktree, ptyIdsByTabId }),
    [ptyIdsByTabId, tabsByWorktree]
  )

  useEffect(() => {
    // Why: hydration exposes restored PTY ids before activation unlocks; prefetching here preserves cold deferral without blocking render.
    if (!enabled && boundPtyIds.length === 0) {
      return
    }
    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const synchronize = async (): Promise<void> => {
      const retryDelayMs = await synchronizeTerminalProviderSnapshotCapabilities(boundPtyIds)
      if (!disposed && retryDelayMs !== null) {
        retryTimer = setTimeout(() => void synchronize(), Math.max(1, retryDelayMs))
      }
    }
    void synchronize()
    return () => {
      disposed = true
      clearTimeout(retryTimer)
    }
  }, [boundPtyIds, enabled])
}
