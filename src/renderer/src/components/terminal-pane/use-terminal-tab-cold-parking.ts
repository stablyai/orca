/**
 * Per-tab hidden-view parking for TerminalPaneOverlayLayer.
 *
 * Why: owns the cold-park policy bookkeeping (hiddenSince tracking, recheck
 * timers, parked-set selection) and the parked byte-watcher reconciliation so
 * the overlay layer only consumes the final parked tab set when deciding to
 * render a slot as null.
 */
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
  /** Retention-budget force-park (C1 slice B): unlike ordinary parks, the
   *  worktree may hold eviction-exempt tabs, whose panes must stay mounted —
   *  a remount would orphan their live pty (same carve-out as portals). */
  isForceParked?: boolean
  /** Hidden-measuring startup probe from Terminal.tsx — the panes must stay
   *  mounted for their first xterm fit, mirroring the worktree-level guard. */
  shouldMeasureHiddenWorktree: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  /** Tabs cold activation keeps unmounted — parked-equivalent for watcher
   *  purposes. Targeted background restrictions intentionally stay bounded. */
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
  // Why the worktree-scoped set, not the record map: the map is app-global, so
  // subscribing to it re-rendered this worktree on every other worktree's write.
  const sleepingRecordOwnedTabIds = useAppStore(
    useShallow((state) =>
      selectSleepingRecordParkExemptTabIds(state.sleepingAgentSessionsByPaneKey, worktreeId)
    )
  )
  const terminalTabHiddenSinceRef = useRef(new Map<string, number>())
  // Why: view switches hide every tab at once, so the park clock cannot rank them.
  const terminalTabActivationOrderRef = useRef<ReturnType<typeof createTerminalTabActivationOrder>>(
    undefined!
  )
  terminalTabActivationOrderRef.current ??= createTerminalTabActivationOrder()
  // Why (shared measure-clock contract with Terminal.tsx): tab hiddenSince
  // survives a background-measure window so per-tab park deadlines stay in
  // sync with the worktree retention/TTL clock, and a post-measure cool-down
  // re-grants the hysteresis so measure end can't immediately re-park.
  const wasMeasuringHiddenWorktreeRef = useRef(false)
  const measureParkCooldownUntilRef = useRef<number | null>(null)
  const terminalTabParkingTimersRef = useRef<TerminalTabColdParkRecheckTimers>(new Map())
  const parkVerdictRecordsRef = useRef(new Map<string, ParkVerdictFlipRecord>())
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

  // Why: per-tab cold-park policy — hiddenSince bookkeeping, parked-set
  // selection, and one recheck timer per still-pending deadline so React
  // re-renders exactly when the hysteresis elapses instead of polling.
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

    // Why: measure end starts the re-park cool-down (worktree measure-clock
    // contract) — hiddenSince is preserved through the window, so without the
    // cool-down every past-deadline tab would re-park the instant it closes.
    if (shouldMeasureHiddenWorktree) {
      wasMeasuringHiddenWorktreeRef.current = true
    } else {
      if (wasMeasuringHiddenWorktreeRef.current) {
        measureParkCooldownUntilRef.current =
          nowMs + (overrides.coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS)
      }
      wasMeasuringHiddenWorktreeRef.current = false
    }
    // Why: mirrors Terminal.tsx's worktree clock — a visible worktree ends the
    // measure episode outright, so no re-park cool-down is owed.
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
    // Why the ref and not the updater form: returning `current` still dispatches,
    // and React only bails eagerly while the fiber has no pending lanes. This
    // effect re-runs on every tab-model write (runtime titles, unread bumps),
    // so inside any commit cascade the no-op dispatch was what tripped React's
    // root-global nested-update counter — naming this hook in a #185 whose real
    // driver is elsewhere (see src/shared/react-update-depth-attribution.ts).
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

  // Why subscribed: the exemption also reads layout leaf PTYs, which change
  // without a terminalTabs change (split added, pty re-minted); gated on
  // isForceParked so only force-parked worktrees build the key per store change.
  const evictionExemptLayoutKey = useAppStore((state) =>
    isForceParked ? selectEvictionExemptTerminalTabLayoutKey(state, terminalTabs) : ''
  )
  // Why memoized: resolving an exemption re-reads the store and walks the
  // layout tree per tab, so recompute only when the force-park verdict, the
  // tabs, or their layout PTYs change — not on every assignment/park-set change
  // below.
  const evictionExemptTerminalTabIds = useMemo(
    () =>
      isForceParked ? selectEvictionExemptTerminalTabIds(worktreeId, terminalTabs) : EMPTY_TAB_IDS,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the layout key encodes the store fields the selector re-reads internally.
    [evictionExemptLayoutKey, isForceParked, terminalTabs, worktreeId]
  )

  // Why: the park verdict before damping — worktree-level park (prop from
  // Terminal.tsx) or per-tab cold park, never portal-hosted tabs. Render and
  // the watcher-sync effect must share the pinned result below so watcher
  // lifecycle tracks the committed unmounts.
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
            // Why: a pane owning a sleeping-session record must stay mountable
            // on an active worktree — parked it can never cold-restore, so the
            // agent's resume strands until the user reveals the tab. Scoped to
            // per-tab parks: the worktree-level park clears on activation.
            !sleepingRecordOwnedTabIds.has(terminalTab.id))) &&
        !hasActivityTerminalPortal &&
        // Why: a force-parked worktree's eviction-exempt tabs keep their
        // mounted panes — a remount would orphan their live pty. Scoped to
        // force-parks: ordinary parks never contain exempt tabs (eligibility
        // requires every tab restorable, so the memo is empty for them).
        !evictionExemptTerminalTabIds.has(terminalTab.id) &&
        // Why: CLI splits against a parked tab replay as soon as its exact pane remounts.
        !terminalPaneSplitMountLeaseTabIds.has(terminalTab.id) &&
        // Why: the hidden-measuring startup probe needs mounted panes; gate
        // here too so the reveal lands in the same render that starts it.
        !shouldMeasureHiddenWorktree
      ) {
        parked.add(terminalTab.id)
      }
      // Why: activation-deferred tabs render no pane regardless of the park
      // policy, so watchers must own their side effects immediately. Targeted
      // restrictions do not enter this set or add a new eager watcher burst.
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

  // Why the last gate: flips are counted on the *rendered* verdict, so damping
  // has to subtract from that same set — coldParkTerminalPanes and the
  // activation-deferred branch never pass through the cold-park candidate list
  // withholdUnparkableTerminalTabs filters (issue #15136).
  const parkedTerminalTabIds = useTerminalParkVerdictPin({
    records: parkVerdictRecordsRef,
    terminalTabs,
    candidateParkedTabIds: candidateParkedTerminalTabIds
  })

  // Why: runs in the same effect flush as the commit that parked/revealed the
  // panes — watcher disposal therefore lands before any PTY data IPC can
  // reach a freshly remounted pane, and watcher start lands after the parked
  // pane's unmount capture.
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
