import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  collectTerminalProviderSnapshotPtyIds,
  startTerminalProviderSnapshotCapabilitySynchronization
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
    return startTerminalProviderSnapshotCapabilitySynchronization(boundPtyIds)
  }, [boundPtyIds, enabled])
}
