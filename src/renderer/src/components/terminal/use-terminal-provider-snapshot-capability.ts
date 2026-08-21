import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import {
  collectTerminalProviderSnapshotPtyIds,
  getTerminalProviderSnapshotCapabilityRevision,
  subscribeTerminalProviderSnapshotCapability,
  startTerminalProviderSnapshotCapabilitySynchronization
} from './terminal-provider-snapshot-capability'

export function useTerminalProviderSnapshotCapability(enabled: boolean): number {
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((state) => state.ptyIdsByTabId)
  const pendingReconnectPtyIdByTabId = useAppStore((state) => state.pendingReconnectPtyIdByTabId)
  const terminalLayoutsByTabId = useAppStore((state) => state.terminalLayoutsByTabId)
  // Why the full field set: synchronization PRUNES cached verdicts outside the
  // collected ids, so a collector narrower than startup's (App.tsx refresh
  // passes full state) would evict valid answers for split-leaf and
  // pending-reconnect ptys back into the exempt-by-default unknown state.
  // Why keyed: layouts change without changing the pty set (active-leaf churn);
  // the synchronization loop must restart only on genuine id-set changes.
  // Why memoized on the map identities: this runs at Terminal's render cadence,
  // and only a change to one of the four collected maps can alter the id set.
  const boundPtyIdsKey = useMemo(
    () =>
      JSON.stringify(
        collectTerminalProviderSnapshotPtyIds({
          tabsByWorktree,
          ptyIdsByTabId,
          pendingReconnectPtyIdByTabId,
          terminalLayoutsByTabId
        }).sort()
      ),
    [tabsByWorktree, ptyIdsByTabId, pendingReconnectPtyIdByTabId, terminalLayoutsByTabId]
  )
  const boundPtyIds = useMemo(() => JSON.parse(boundPtyIdsKey) as string[], [boundPtyIdsKey])
  const capabilityRevision = useSyncExternalStore(
    subscribeTerminalProviderSnapshotCapability,
    getTerminalProviderSnapshotCapabilityRevision,
    getTerminalProviderSnapshotCapabilityRevision
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
