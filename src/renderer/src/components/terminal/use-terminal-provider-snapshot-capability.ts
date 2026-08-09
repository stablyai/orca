import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import {
  collectTerminalProviderSnapshotPtyIds,
  getTerminalProviderSnapshotCapabilityRevision,
  subscribeTerminalProviderSnapshotCapabilityRevision,
  startTerminalProviderSnapshotCapabilitySynchronization
} from './terminal-provider-snapshot-capability'

export function useTerminalProviderSnapshotCapability(enabled: boolean): number {
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((state) => state.ptyIdsByTabId)
  const capabilityRevision = useSyncExternalStore(
    subscribeTerminalProviderSnapshotCapabilityRevision,
    getTerminalProviderSnapshotCapabilityRevision,
    getTerminalProviderSnapshotCapabilityRevision
  )
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

  return capabilityRevision
}
