/** Own per-tab park clocks, deadlines, and watcher reconciliation so the overlay consumes only the final render verdict. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '../../store'
import {
  findActivityTerminalPortal,
  type ActivityTerminalPortalTarget
} from '../activity/activity-terminal-portal'
import { getTerminalTabColdParkRecheckDelayMs } from './terminal-cold-park-recheck-deadlines'
import {
  clearTerminalTabColdParkRecheckTimers,
  reconcileTerminalTabColdParkRecheckTimers,
  type TerminalTabColdParkRecheckTimers
} from './terminal-cold-park-recheck-timers'
import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  selectPairedRuntimeParkingEnvironmentIdsFromState,
  selectColdParkedTerminalTabs
} from './terminal-hidden-view-parking'
import type { ParkVerdictFlipRecord } from './terminal-park-verdict-flip-telemetry'
import { haveSameTerminalTabIds, useTerminalParkVerdictPin } from './use-terminal-park-verdict-pin'
import { withholdUnparkableTerminalTabs } from './terminal-cold-park-withheld-tabs'
import { getTerminalParkingPolicyOverrides } from './terminal-parking-e2e-overrides'
import {
  selectEvictionExemptTerminalTabIds,
  selectEvictionExemptTerminalTabLayoutKey
} from './terminal-eviction-exempt-tabs'
import { selectSleepingRecordParkExemptTabIds } from './sleeping-record-park-exemption'
import { usePendingStartupParkPresence } from './terminal-pending-startup-park-presence'
import { canWatcherCoverParkedTerminalTab } from './terminal-parked-tab-watchers'
import { captureNewlyParkedTerminalTabs } from './parked-terminal-tab-capture-episodes'
import { createTerminalTabActivationOrder } from './terminal-tab-activation-order'
import { buildTerminalTabColdParkCandidates } from './terminal-tab-park-candidates'
import {
  getTerminalParkingAssignmentsKey,
  getTerminalParkingInputsKey,
  useParkedTerminalWatcherSynchronization
} from './use-parked-terminal-watcher-synchronization'
import {
  getTerminalPaneSplitMountLeaseTabIds,
  subscribeTerminalPaneSplitMountLeases
} from './terminal-pane-split-request-routing'

type TerminalOverlayTabAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()

export function useTerminalTabColdParking(args: {
  worktreeId: string
  terminalTabs: readonly TerminalTab[]
  assignments: ReadonlyMap<string, TerminalOverlayTabAssignment>
  isWorktreeActive: boolean
  activeTerminalTabId: string | null
  /** Worktree-level park verdict from Terminal.tsx. */
  coldParkTerminalPanes: boolean
  /** Force-parks may contain unrestorable live PTYs; keep exempt panes mounted to avoid orphaning them. */
  isForceParked?: boolean
  /** Keep hidden startup probes mounted for their first xterm fit. */
  shouldMeasureHiddenWorktree: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  /** Activation-deferred tabs need parked watchers; targeted restrictions stay bounded. */
  activationDeferredMountTabIds?: ReadonlySet<string> | null
}): ReadonlySet<string> {
  const {
    worktreeId,
    terminalTabs,
    assignments,
    isWorktreeActive,
    activeTerminalTabId,
    coldParkTerminalPanes,
    isForceParked = false,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals,
    activationDeferredMountTabIds
  } = args
  const terminalParkingInputsKey = useMemo(
    () => getTerminalParkingInputsKey(terminalTabs),
    [terminalTabs]
  )
  const terminalParkingAssignmentsKey = useMemo(
    () => getTerminalParkingAssignmentsKey(assignments),
    [assignments]
  )
  const terminalParkingTabsDependency = coldParkTerminalPanes
    ? terminalParkingInputsKey
    : terminalTabs
  const terminalParkingAssignmentsDependency = coldParkTerminalPanes
    ? terminalParkingAssignmentsKey
    : assignments
  const pendingStartupByTabId = usePendingStartupParkPresence(terminalTabs)
  const terminalParkingEnabled = useAppStore(
    (state) => state.settings?.terminalHiddenViewParking !== false
  )
  const terminalSshParkingEnabled = useAppStore(
    (state) => state.settings?.terminalSshViewParking !== false
  )
  const terminalPaneSplitMountLeaseTabIds = useSyncExternalStore(
    subscribeTerminalPaneSplitMountLeases,
    getTerminalPaneSplitMountLeaseTabIds,
    getTerminalPaneSplitMountLeaseTabIds
  )
  const pairedRuntimeParkingEnvironmentIds = useAppStore(
    selectPairedRuntimeParkingEnvironmentIdsFromState
  )
  // Subscribe to worktree-scoped presence; the app-global map rerenders this worktree for unrelated writes.
  const sleepingRecordOwnedTabIds = useAppStore(
    useShallow((state) => selectSleepingRecordParkExemptTabIds(state, worktreeId))
  )
  const terminalTabHiddenSinceRef = useRef(new Map<string, number>())
  // Why: view switches hide every tab at once, so the park clock cannot rank them.
  const terminalTabActivationOrderRef = useRef<ReturnType<typeof createTerminalTabActivationOrder>>(
    undefined!
  )
  terminalTabActivationOrderRef.current ??= createTerminalTabActivationOrder()
  // Preserve hiddenSince through measurement to match worktree deadlines; cooldown prevents immediate re-park afterward.
  const wasMeasuringHiddenWorktreeRef = useRef(false)
  const measureParkCooldownUntilRef = useRef<number | null>(null)
  const terminalTabParkingTimersRef = useRef<TerminalTabColdParkRecheckTimers>(new Map())
  const parkVerdictRecordsRef = useRef(new Map<string, ParkVerdictFlipRecord>())
  const parkedTabCaptureDoneRef = useRef(new Set<string>())
  const [terminalTabParkingRevision, setTerminalTabParkingRevision] = useState(0)
  const [coldParkedTerminalTabIds, setColdParkedTerminalTabIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  // Mirrors the committed park set; written only from the post-commit effect below.
  const coldParkedTerminalTabIdsRef = useRef(coldParkedTerminalTabIds)

  useEffect(() => {
    const timers = terminalTabParkingTimersRef.current
    return () => clearTerminalTabColdParkRecheckTimers(timers)
  }, [])

  // Schedule pending hysteresis deadlines instead of polling.
  useEffect(() => {
    const timers = terminalTabParkingTimersRef.current
    const nowMs = Date.now()
    const overrides = getTerminalParkingPolicyOverrides()
    const currentTerminalTabIds = new Set(terminalTabs.map((tab) => tab.id))
    const portalTabIds = new Set(
      activityTerminalPortals
        .filter((portal) => portal.worktreeId === worktreeId)
        .map((portal) => portal.tabId)
    )
    for (const tabId of Array.from(terminalTabHiddenSinceRef.current.keys())) {
      if (!currentTerminalTabIds.has(tabId)) {
        terminalTabHiddenSinceRef.current.delete(tabId)
      }
    }
    terminalTabActivationOrderRef.current.retainTabIds(currentTerminalTabIds)

    // Measurement preserves hiddenSince, so its end needs cooldown to prevent immediate re-park.
    if (shouldMeasureHiddenWorktree) {
      wasMeasuringHiddenWorktreeRef.current = true
    } else {
      if (wasMeasuringHiddenWorktreeRef.current) {
        measureParkCooldownUntilRef.current =
          nowMs + (overrides.coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS)
      }
      wasMeasuringHiddenWorktreeRef.current = false
    }
    // A visible worktree ends measurement outright and owes no re-park cooldown.
    if (isWorktreeActive) {
      measureParkCooldownUntilRef.current = null
    }

    const candidates = buildTerminalTabColdParkCandidates({
      terminalTabs,
      assignments,
      isWorktreeActive,
      activeTerminalTabId,
      portalTabIds,
      shouldMeasureHiddenWorktree,
      hiddenSinceByTabId: terminalTabHiddenSinceRef.current,
      activationOrder: terminalTabActivationOrderRef.current,
      nowMs
    })

    const nextColdParkedTerminalTabIds = selectColdParkedTerminalTabs({
      worktreeId,
      terminalTabs: candidates,
      pendingStartupByTabId,
      parkingEnabled: terminalParkingEnabled,
      nowMs,
      parkCooldownUntilMs: measureParkCooldownUntilRef.current,
      restorePolicy: {
        sshParkingEnabled: terminalSshParkingEnabled,
        pairedRuntimeParkingEnvironmentIds
      },
      ...overrides
    })
    const { parkedTabIds, parkVerdictPinUntilMsByTabId } = withholdUnparkableTerminalTabs({
      worktreeId,
      terminalTabs,
      coldParkedTabIds: nextColdParkedTerminalTabIds,
      parkVerdictRecords: parkVerdictRecordsRef.current,
      nowMs
    })
    // Capture scrollback while panes are still mounted, before committing the park unmount.
    captureNewlyParkedTerminalTabs(worktreeId, parkedTabIds, parkedTabCaptureDoneRef.current)
    // Compare via ref before dispatch: no-op updater dispatches can still hit React’s global nested-update limit inside a commit cascade.
    if (!haveSameTerminalTabIds(coldParkedTerminalTabIdsRef.current, parkedTabIds)) {
      coldParkedTerminalTabIdsRef.current = parkedTabIds
      setColdParkedTerminalTabIds(parkedTabIds)
    }

    const recheckDeadlineMsByTabId = new Map<string, number>()
    for (const candidate of candidates) {
      if (
        candidate.isVisible ||
        candidate.hasActivityTerminalPortal ||
        parkedTabIds.has(candidate.id)
      ) {
        continue
      }
      const delayMs = getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: terminalParkingEnabled,
        hiddenSinceMs: candidate.hiddenSinceMs,
        parkCooldownUntilMs: measureParkCooldownUntilRef.current,
        // Why: pin expiry may be the only remaining wakeup after damping stops churn.
        parkVerdictPinUntilMs: parkVerdictPinUntilMsByTabId.get(candidate.id) ?? null,
        nowMs,
        ...overrides
      })
      if (delayMs !== null && delayMs > 0) {
        recheckDeadlineMsByTabId.set(candidate.id, nowMs + delayMs)
      }
    }

    reconcileTerminalTabColdParkRecheckTimers({
      timers,
      deadlineMsByTabId: recheckDeadlineMsByTabId,
      nowMs,
      onDeadline: () => setTerminalTabParkingRevision((revision) => revision + 1)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- semantic keys own the tab and assignment dependencies.
  }, [
    activityTerminalPortals,
    activeTerminalTabId,
    isWorktreeActive,
    pendingStartupByTabId,
    pairedRuntimeParkingEnvironmentIds,
    shouldMeasureHiddenWorktree,
    terminalParkingEnabled,
    terminalSshParkingEnabled,
    terminalTabParkingRevision,
    terminalParkingAssignmentsDependency,
    terminalParkingTabsDependency,
    worktreeId
  ])

  // Force-park exemptions depend on layout leaf PTYs even when terminalTabs is unchanged.
  const evictionExemptLayoutKey = useAppStore((state) =>
    isForceParked ? selectEvictionExemptTerminalTabLayoutKey(state, terminalTabs) : ''
  )
  // Cache exemption layout walks until force-park, tabs, or layout PTYs change.
  const evictionExemptTerminalTabIds = useMemo(
    () =>
      isForceParked ? selectEvictionExemptTerminalTabIds(worktreeId, terminalTabs) : EMPTY_TAB_IDS,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the layout key encodes the store fields the selector re-reads internally.
    [evictionExemptLayoutKey, isForceParked, terminalTabs, worktreeId]
  )

  // Render and watcher sync must share the pinned verdict, excluding portal-hosted tabs.
  const candidateParkedTerminalTabIds = useMemo(() => {
    const parked = new Set<string>()
    for (const terminalTab of terminalTabs) {
      const assignment = assignments.get(terminalTab.id)
      const isVisible = Boolean(isWorktreeActive && assignment && assignment.isActiveInGroup)
      const hasActivityTerminalPortal =
        findActivityTerminalPortal(activityTerminalPortals, {
          worktreeId,
          tabId: terminalTab.id
        }) !== null
      if (
        (coldParkTerminalPanes ||
          (!isVisible &&
            coldParkedTerminalTabIds.has(terminalTab.id) &&
            // Active worktree sleeping sessions need mountable panes for cold restore; worktree-level parks clear on activation.
            !sleepingRecordOwnedTabIds.has(terminalTab.id))) &&
        !hasActivityTerminalPortal &&
        // Retain force-park exemptions to avoid orphaning live PTYs; ordinary parks require every tab restorable.
        !evictionExemptTerminalTabIds.has(terminalTab.id) &&
        // Why: CLI splits against a parked tab replay as soon as its exact pane remounts.
        !terminalPaneSplitMountLeaseTabIds.has(terminalTab.id) &&
        // Startup measurement needs panes mounted in the render that begins the probe.
        !shouldMeasureHiddenWorktree
      ) {
        parked.add(terminalTab.id)
      }
      // Activation deferral removes panes immediately, so start their watchers now; targeted restrictions must not expand eager coverage.
      if (
        activationDeferredMountTabIds?.has(terminalTab.id) &&
        !hasActivityTerminalPortal &&
        canWatcherCoverParkedTerminalTab(worktreeId, terminalTab)
      ) {
        parked.add(terminalTab.id)
      }
    }
    return parked
  }, [
    activityTerminalPortals,
    assignments,
    coldParkTerminalPanes,
    coldParkedTerminalTabIds,
    activationDeferredMountTabIds,
    evictionExemptTerminalTabIds,
    isWorktreeActive,
    shouldMeasureHiddenWorktree,
    sleepingRecordOwnedTabIds,
    terminalTabs,
    terminalPaneSplitMountLeaseTabIds,
    worktreeId
  ])

  // Damp the final rendered set because worktree parks and activation deferral bypass the cold-park candidate filter (#15136).
  const parkedTerminalTabIds = useTerminalParkVerdictPin({
    records: parkVerdictRecordsRef,
    terminalTabs,
    candidateParkedTabIds: candidateParkedTerminalTabIds,
    allowSustainedPin: !isForceParked
  })

  // Sync in the park/reveal effect flush: dispose watchers before remounted-pane IPC and start them after unmount capture.
  useParkedTerminalWatcherSynchronization({
    worktreeId,
    terminalTabs,
    assignmentsKey: terminalParkingAssignmentsKey,
    inputsKey: terminalParkingInputsKey,
    parkedTabIds: parkedTerminalTabIds,
    activationDeferredMountTabIds
  })

  return parkedTerminalTabIds
}
