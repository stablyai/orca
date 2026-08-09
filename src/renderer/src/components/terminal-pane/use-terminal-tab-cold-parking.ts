/** Per-tab hidden-view parking coordinator for TerminalPaneOverlayLayer. */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { TerminalTab } from '../../../../shared/types'
import { useAppStore } from '../../store'
import {
  getTerminalProviderSnapshotCapabilityRevision,
  subscribeTerminalProviderSnapshotCapabilityRevision
} from '../terminal/terminal-provider-snapshot-capability'
import type { ActivityTerminalPortalTarget } from '../activity/activity-terminal-portal'
import { selectPairedRuntimeParkingEnvironmentIds } from './terminal-hidden-view-parking'
import {
  recordParkVerdictFlips,
  type ParkVerdictFlipRecord
} from './terminal-park-verdict-flip-telemetry'
import {
  selectEvictionExemptTerminalTabIds,
  selectEvictionExemptTerminalTabLayoutKey
} from './terminal-eviction-exempt-tabs'
import { selectSleepingRecordParkExemptTabIds } from './sleeping-record-park-exemption'
import { createParkedTerminalWatcherTopologyKey } from './terminal-parked-watcher-reconciliation'
import {
  useTerminalTabColdParkCandidates,
  type TerminalOverlayTabAssignment
} from './use-terminal-tab-cold-park-candidates'
import { useTerminalTabParkEpisodes } from './use-terminal-tab-park-episodes'

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()

export function useTerminalTabColdParking(args: {
  worktreeId: string
  terminalTabs: readonly TerminalTab[]
  assignments: ReadonlyMap<string, TerminalOverlayTabAssignment>
  isWorktreeActive: boolean
  coldParkTerminalPanes: boolean
  isForceParked?: boolean
  shouldMeasureHiddenWorktree: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  activationDeferredMountTabIds?: ReadonlySet<string> | null
  onActivationDeferredWatcherHandoffFailed?: (tabId: string) => void
}): ReadonlySet<string> {
  const {
    worktreeId,
    terminalTabs,
    assignments,
    isWorktreeActive,
    coldParkTerminalPanes,
    isForceParked = false,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals,
    activationDeferredMountTabIds,
    onActivationDeferredWatcherHandoffFailed
  } = args
  const pendingStartupByTabId = useAppStore((state) => state.pendingStartupByTabId)
  const terminalParkingEnabled = useAppStore(
    (state) => state.settings?.terminalHiddenViewParking !== false
  )
  const terminalSshParkingEnabled = useAppStore(
    (state) => state.settings?.terminalSshViewParking !== false
  )
  const runtimeStatusByEnvironmentId = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const pairedRuntimeParkingEnvironmentIds = useMemo(
    () => selectPairedRuntimeParkingEnvironmentIds(runtimeStatusByEnvironmentId),
    [runtimeStatusByEnvironmentId]
  )
  const watcherRestoreAuthorityKey = useMemo(
    () =>
      JSON.stringify([
        terminalSshParkingEnabled,
        [...pairedRuntimeParkingEnvironmentIds].sort((left, right) => left.localeCompare(right))
      ]),
    [pairedRuntimeParkingEnvironmentIds, terminalSshParkingEnabled]
  )
  const watcherLayoutsByTabId = useAppStore(
    useShallow((state) => {
      const layouts: typeof state.terminalLayoutsByTabId = {}
      for (const terminalTab of terminalTabs) {
        const layout = state.terminalLayoutsByTabId[terminalTab.id]
        if (layout) {
          layouts[terminalTab.id] = layout
        }
      }
      return layouts
    })
  )
  const watcherTopologyKey = useMemo(
    () =>
      createParkedTerminalWatcherTopologyKey(worktreeId, terminalTabs, {
        terminalLayoutsByTabId: watcherLayoutsByTabId
      }),
    [terminalTabs, watcherLayoutsByTabId, worktreeId]
  )
  const providerCapabilityRevision = useSyncExternalStore(
    subscribeTerminalProviderSnapshotCapabilityRevision,
    getTerminalProviderSnapshotCapabilityRevision,
    getTerminalProviderSnapshotCapabilityRevision
  )
  const sleepingAgentSessionsByPaneKey = useAppStore(
    (state) => state.sleepingAgentSessionsByPaneKey
  )
  const sleepingRecordOwnedTabIds = useMemo(
    () => selectSleepingRecordParkExemptTabIds(sleepingAgentSessionsByPaneKey, worktreeId),
    [sleepingAgentSessionsByPaneKey, worktreeId]
  )

  const coldParkCandidateTabIds = useTerminalTabColdParkCandidates({
    worktreeId,
    terminalTabs,
    assignments,
    isWorktreeActive,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals,
    pendingStartupByTabId,
    terminalParkingEnabled,
    terminalSshParkingEnabled,
    pairedRuntimeParkingEnvironmentIds
  })

  const evictionExemptLayoutKey = useAppStore((state) =>
    isForceParked ? selectEvictionExemptTerminalTabLayoutKey(state, terminalTabs) : ''
  )
  const evictionExemptionSnapshot = useMemo(
    () => ({
      layoutKey: evictionExemptLayoutKey,
      tabIds: isForceParked
        ? selectEvictionExemptTerminalTabIds(worktreeId, terminalTabs)
        : EMPTY_TAB_IDS
    }),
    [evictionExemptLayoutKey, isForceParked, terminalTabs, worktreeId]
  )

  const parkedTerminalTabIds = useTerminalTabParkEpisodes({
    worktreeId,
    terminalTabs,
    assignments,
    isWorktreeActive,
    coldParkTerminalPanes,
    isForceParked,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals,
    activationDeferredMountTabIds,
    onActivationDeferredWatcherHandoffFailed,
    terminalParkingEnabled,
    coldParkCandidateTabIds,
    sleepingRecordOwnedTabIds,
    evictionExemptTerminalTabIds: evictionExemptionSnapshot.tabIds,
    providerCapabilityRevision,
    watcherTopologyKey,
    watcherRestoreAuthorityKey
  })

  const parkVerdictRecordsRef = useRef(new Map<string, ParkVerdictFlipRecord>())
  useEffect(() => {
    recordParkVerdictFlips({
      records: parkVerdictRecordsRef.current,
      liveTabIds: new Set(terminalTabs.map((terminalTab) => terminalTab.id)),
      nextParkedTabIds: parkedTerminalTabIds,
      nowMs: Date.now()
    })
  }, [parkedTerminalTabIds, terminalTabs])

  return parkedTerminalTabIds
}
