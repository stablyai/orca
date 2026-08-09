import { useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalTab } from '../../../../shared/types'
import {
  findActivityTerminalPortal,
  type ActivityTerminalPortalTarget
} from '../activity/activity-terminal-portal'
import {
  disposeParkedTerminalWatchersForWorktree,
  planParkedTerminalTabWatcherCoverage,
  subscribeParkedTerminalWatcherOwnershipLoss,
  syncParkedTerminalTabWatchersWithAcknowledgements,
  type TerminalParkedWatcherCoveragePlan
} from './terminal-parked-tab-watchers'
import {
  acknowledgeTerminalParkEpisodeSet,
  reconcileTerminalParkEpisodeSet,
  selectCurrentTerminalParkEpisodeUnmounts,
  type TerminalParkEpisodeSet
} from './terminal-park-episode-set'
import { terminalParkedWatcherPlanPtyIds } from './terminal-park-episode-lease'
import type { TerminalOverlayTabAssignment } from './use-terminal-tab-cold-park-candidates'

type TerminalTabParkRequests = {
  requestedTabIds: ReadonlySet<string>
  forcedTabIds: ReadonlySet<string>
}

function selectTerminalTabParkRequests(args: {
  worktreeId: string
  terminalTabs: readonly TerminalTab[]
  assignments: ReadonlyMap<string, TerminalOverlayTabAssignment>
  isWorktreeActive: boolean
  coldParkTerminalPanes: boolean
  isForceParked: boolean
  shouldMeasureHiddenWorktree: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  activationDeferredMountTabIds?: ReadonlySet<string> | null
  terminalParkingEnabled: boolean
  coldParkCandidateTabIds: ReadonlySet<string>
  sleepingRecordOwnedTabIds: ReadonlySet<string>
  evictionExemptTerminalTabIds: ReadonlySet<string>
}): TerminalTabParkRequests {
  const requestedTabIds = new Set<string>()
  const forcedTabIds = new Set<string>()
  for (const terminalTab of args.terminalTabs) {
    const assignment = args.assignments.get(terminalTab.id)
    const isVisible = Boolean(args.isWorktreeActive && assignment && assignment.isActiveInGroup)
    const hasActivityTerminalPortal =
      findActivityTerminalPortal(args.activityTerminalPortals, {
        worktreeId: args.worktreeId,
        tabId: terminalTab.id
      }) !== null
    if (hasActivityTerminalPortal) {
      continue
    }
    const forcePark =
      args.terminalParkingEnabled &&
      args.coldParkTerminalPanes &&
      args.isForceParked &&
      !args.shouldMeasureHiddenWorktree &&
      !args.evictionExemptTerminalTabIds.has(terminalTab.id)
    const ordinaryPark =
      args.terminalParkingEnabled &&
      !args.shouldMeasureHiddenWorktree &&
      ((args.coldParkTerminalPanes && !args.isForceParked) ||
        (!isVisible &&
          args.coldParkCandidateTabIds.has(terminalTab.id) &&
          !args.sleepingRecordOwnedTabIds.has(terminalTab.id)))
    const activationDeferred =
      args.terminalParkingEnabled &&
      args.activationDeferredMountTabIds?.has(terminalTab.id) === true &&
      !args.sleepingRecordOwnedTabIds.has(terminalTab.id)
    if (forcePark || ordinaryPark || activationDeferred) {
      requestedTabIds.add(terminalTab.id)
    }
    if (forcePark) {
      forcedTabIds.add(terminalTab.id)
    }
  }
  return { requestedTabIds, forcedTabIds }
}

export function useTerminalTabParkEpisodes(args: {
  worktreeId: string
  terminalTabs: readonly TerminalTab[]
  assignments: ReadonlyMap<string, TerminalOverlayTabAssignment>
  isWorktreeActive: boolean
  coldParkTerminalPanes: boolean
  isForceParked: boolean
  shouldMeasureHiddenWorktree: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  activationDeferredMountTabIds?: ReadonlySet<string> | null
  onActivationDeferredWatcherHandoffFailed?: (tabId: string) => void
  terminalParkingEnabled: boolean
  coldParkCandidateTabIds: ReadonlySet<string>
  sleepingRecordOwnedTabIds: ReadonlySet<string>
  evictionExemptTerminalTabIds: ReadonlySet<string>
  providerCapabilityRevision: number
  watcherTopologyKey: string
  watcherRestoreAuthorityKey: string
}): ReadonlySet<string> {
  const {
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
    evictionExemptTerminalTabIds,
    providerCapabilityRevision,
    watcherTopologyKey,
    watcherRestoreAuthorityKey
  } = args
  const leasesRef = useRef<TerminalParkEpisodeSet>(new Map())
  const [, setLeaseRevision] = useState(0)

  const parkRequests = useMemo(
    () =>
      selectTerminalTabParkRequests({
        worktreeId,
        terminalTabs,
        assignments,
        isWorktreeActive,
        coldParkTerminalPanes,
        isForceParked,
        shouldMeasureHiddenWorktree,
        activityTerminalPortals,
        activationDeferredMountTabIds,
        terminalParkingEnabled,
        coldParkCandidateTabIds,
        sleepingRecordOwnedTabIds,
        evictionExemptTerminalTabIds
      }),
    [
      activationDeferredMountTabIds,
      activityTerminalPortals,
      assignments,
      coldParkCandidateTabIds,
      coldParkTerminalPanes,
      evictionExemptTerminalTabIds,
      isForceParked,
      isWorktreeActive,
      shouldMeasureHiddenWorktree,
      sleepingRecordOwnedTabIds,
      terminalParkingEnabled,
      terminalTabs,
      worktreeId
    ]
  )

  const coverageMaterialRevision = JSON.stringify([
    providerCapabilityRevision,
    watcherTopologyKey,
    watcherRestoreAuthorityKey
  ])
  const coveragePlanSnapshot = useMemo(() => {
    const plansByTabId = new Map<string, TerminalParkedWatcherCoveragePlan>()
    for (const terminalTab of terminalTabs) {
      if (parkRequests.requestedTabIds.has(terminalTab.id)) {
        plansByTabId.set(
          terminalTab.id,
          planParkedTerminalTabWatcherCoverage(worktreeId, terminalTab)
        )
      }
    }
    return { materialRevision: coverageMaterialRevision, plansByTabId }
  }, [coverageMaterialRevision, parkRequests.requestedTabIds, terminalTabs, worktreeId])

  const renderBaseLeases = leasesRef.current
  const reconciledForRender = reconcileTerminalParkEpisodeSet({
    current: renderBaseLeases,
    tabs: terminalTabs,
    requestedTabIds: parkRequests.requestedTabIds,
    forcedTabIds: parkRequests.forcedTabIds,
    plan: (tab) => {
      const plan = coveragePlanSnapshot.plansByTabId.get(tab.id)
      if (!plan) {
        throw new Error(`Missing terminal park plan for ${tab.id}`)
      }
      return plan
    }
  })
  const parkedTerminalTabIds = useMemo(
    () =>
      selectCurrentTerminalParkEpisodeUnmounts({
        leases: reconciledForRender.leases,
        plansByTabId: coveragePlanSnapshot.plansByTabId,
        requestedTabIds: parkRequests.requestedTabIds,
        forcedTabIds: parkRequests.forcedTabIds
      }),
    [coveragePlanSnapshot, parkRequests, reconciledForRender.leases]
  )

  useEffect(() => {
    if (leasesRef.current === renderBaseLeases) {
      leasesRef.current = reconciledForRender.leases
    }
    for (const tabId of activationDeferredMountTabIds ?? []) {
      if (!parkedTerminalTabIds.has(tabId)) {
        onActivationDeferredWatcherHandoffFailed?.(tabId)
      }
    }
  }, [
    activationDeferredMountTabIds,
    onActivationDeferredWatcherHandoffFailed,
    parkedTerminalTabIds,
    reconciledForRender.leases,
    renderBaseLeases
  ])

  useEffect(() => {
    const acknowledgements = syncParkedTerminalTabWatchersWithAcknowledgements({
      worktreeId,
      tabs: terminalTabs,
      parkedTabIds: parkedTerminalTabIds,
      coveragePlansByTabId: coveragePlanSnapshot.plansByTabId,
      forcedTabIds: parkRequests.forcedTabIds,
      restoreTitleOnStartTabIds: activationDeferredMountTabIds ?? undefined
    })
    const acknowledged = acknowledgeTerminalParkEpisodeSet(leasesRef.current, acknowledgements)
    leasesRef.current = acknowledged.leases
    if (!acknowledged.renderChanged) {
      return
    }
    for (const acknowledgement of acknowledgements) {
      if (
        acknowledgement.status === 'failed' &&
        activationDeferredMountTabIds?.has(acknowledgement.tabId)
      ) {
        onActivationDeferredWatcherHandoffFailed?.(acknowledgement.tabId)
      }
    }
    setLeaseRevision((revision) => revision + 1)
  }, [
    activationDeferredMountTabIds,
    coveragePlanSnapshot,
    onActivationDeferredWatcherHandoffFailed,
    parkedTerminalTabIds,
    parkRequests.forcedTabIds,
    terminalTabs,
    worktreeId
  ])

  useEffect(
    () =>
      subscribeParkedTerminalWatcherOwnershipLoss((event) => {
        if (event.worktreeId !== worktreeId) {
          return
        }
        const lease = leasesRef.current.get(event.tabId)
        if (!lease || lease.phase === 'forced') {
          return
        }
        const acknowledged = acknowledgeTerminalParkEpisodeSet(leasesRef.current, [
          {
            status: 'failed',
            tabId: event.tabId,
            materialKey: lease.plan.materialKey,
            reason: 'watcher-ownership-lost',
            expectedPtyIds: terminalParkedWatcherPlanPtyIds(lease.plan),
            watchedPtyIds: []
          }
        ])
        if (!acknowledged.renderChanged) {
          return
        }
        leasesRef.current = acknowledged.leases
        if (activationDeferredMountTabIds?.has(event.tabId)) {
          onActivationDeferredWatcherHandoffFailed?.(event.tabId)
        }
        setLeaseRevision((revision) => revision + 1)
      }),
    [activationDeferredMountTabIds, onActivationDeferredWatcherHandoffFailed, worktreeId]
  )

  useEffect(() => () => disposeParkedTerminalWatchersForWorktree(worktreeId), [worktreeId])

  return parkedTerminalTabIds
}
