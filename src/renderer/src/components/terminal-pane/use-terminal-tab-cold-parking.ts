/**
 * Per-tab hidden-view parking for TerminalPaneOverlayLayer.
 *
 * Why: owns the cold-park policy bookkeeping (hiddenSince tracking, recheck
 * timers, parked-set selection) and the parked byte-watcher reconciliation so
 * the overlay layer only consumes the final parked tab set when deciding to
 * render a slot as null.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalTab } from '../../../../shared/types'
import { useAppStore } from '../../store'
import type { ActivityTerminalPortalTarget } from '../activity/activity-terminal-portal'
import { getTerminalTabColdParkRecheckDelayMs } from './terminal-cold-park-recheck-deadlines'
import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  selectColdParkedTerminalTabs,
  type TerminalTabColdParkCandidate
} from './terminal-hidden-view-parking'
import { selectPairedRuntimeParkingEnvironmentIds } from './terminal-park-pty-restore-eligibility'
import { useTerminalParkWorktreeOwner } from './terminal-park-worktree-owner'
import {
  recordParkVerdictFlips,
  type ParkVerdictFlipRecord
} from './terminal-park-verdict-flip-telemetry'
import { withholdUnparkableTerminalTabs } from './terminal-cold-park-withheld-tabs'
import { getTerminalParkingPolicyOverrides } from './terminal-parking-e2e-overrides'
import { selectSleepingRecordParkExemptTabIds } from './sleeping-record-park-exemption'
import { useTerminalForceParkExemptTabIds } from './use-terminal-force-park-exempt-tabs'
import { useTerminalParkAuthorityRevisionKey } from './terminal-park-authority-revision'
import { selectRenderedParkedTerminalTabIds } from './terminal-rendered-parked-tab-ids'
import {
  getTerminalParkingAssignmentsKey,
  getTerminalParkingInputsKey,
  useParkedTerminalWatcherSynchronization
} from './use-parked-terminal-watcher-synchronization'

type TerminalOverlayTabAssignment = { groupId: string; isActiveInGroup: boolean }

function haveSameTerminalTabIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const id of left) {
    if (!right.has(id)) {
      return false
    }
  }
  return true
}

export function useTerminalTabColdParking(args: {
  worktreeId: string
  terminalTabs: readonly TerminalTab[]
  assignments: ReadonlyMap<string, TerminalOverlayTabAssignment>
  isWorktreeActive: boolean
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
    coldParkTerminalPanes,
    isForceParked = false,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals,
    activationDeferredMountTabIds
  } = args
  const terminalParkingInputsKey = getTerminalParkingInputsKey(terminalTabs)
  const terminalParkingAssignmentsKey = getTerminalParkingAssignmentsKey(assignments)
  const terminalParkingTabsDependency = coldParkTerminalPanes
    ? terminalParkingInputsKey
    : terminalTabs
  const terminalParkingAssignmentsDependency = coldParkTerminalPanes
    ? terminalParkingAssignmentsKey
    : assignments
  const pendingStartupByTabId = useAppStore((state) => state.pendingStartupByTabId)
  const terminalParkingEnabled = useAppStore(
    (state) => state.settings?.terminalHiddenViewParking !== false
  )
  const terminalSshParkingEnabled = useAppStore(
    (state) => state.settings?.terminalSshViewParking !== false
  )
  const terminalParkActiveLeafKey = useAppStore((state) =>
    terminalTabs
      .map((tab) => state.terminalLayoutsByTabId[tab.id]?.activeLeafId ?? '')
      .join('\u0000')
  )
  const worktreeOwner = useTerminalParkWorktreeOwner(worktreeId)
  const runtimeStatusByEnvironmentId = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const pairedRuntimeParkingEnvironmentIds = useMemo(
    () => selectPairedRuntimeParkingEnvironmentIds(runtimeStatusByEnvironmentId),
    [runtimeStatusByEnvironmentId]
  )
  const terminalParkAuthorityRevisionKey = useTerminalParkAuthorityRevisionKey(
    worktreeId,
    terminalTabs,
    worktreeOwner
  )
  const sleepingAgentSessionsByPaneKey = useAppStore(
    (state) => state.sleepingAgentSessionsByPaneKey
  )
  const sleepingRecordOwnedTabIds = useMemo(
    () => selectSleepingRecordParkExemptTabIds(sleepingAgentSessionsByPaneKey, worktreeId),
    [sleepingAgentSessionsByPaneKey, worktreeId]
  )
  const terminalTabHiddenSinceRef = useRef(new Map<string, number>())
  // Why (shared measure-clock contract with Terminal.tsx): tab hiddenSince
  // survives a background-measure window so per-tab park deadlines stay in
  // sync with the worktree retention/TTL clock, and a post-measure cool-down
  // re-grants the hysteresis so measure end can't immediately re-park.
  const wasMeasuringHiddenWorktreeRef = useRef(false)
  const measureParkCooldownUntilRef = useRef<number | null>(null)
  const terminalTabParkingTimersRef = useRef(new Map<string, number>())
  const parkVerdictRecordsRef = useRef(new Map<string, ParkVerdictFlipRecord>())
  const [terminalTabParkingRevision, setTerminalTabParkingRevision] = useState(0)
  const [coldParkedTerminalTabIds, setColdParkedTerminalTabIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )

  useEffect(() => {
    const timers = terminalTabParkingTimersRef.current
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer)
      }
      timers.clear()
    }
  }, [])

  // Why: per-tab cold-park policy — hiddenSince bookkeeping, parked-set
  // selection, and one recheck timer per still-pending deadline so React
  // re-renders exactly when the hysteresis elapses instead of polling.
  useEffect(() => {
    const timers = terminalTabParkingTimersRef.current
    for (const timer of timers.values()) {
      window.clearTimeout(timer)
    }
    timers.clear()

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

    const activeLeafIds = terminalParkActiveLeafKey.split('\u0000')
    const candidates: TerminalTabColdParkCandidate[] = terminalTabs.map((terminalTab, index) => {
      const assignment = assignments.get(terminalTab.id)
      const isVisible = Boolean(isWorktreeActive && assignment && assignment.isActiveInGroup)
      const hasActivityTerminalPortal = portalTabIds.has(terminalTab.id)
      // Why measuring preserves the clock: the startup probe still needs
      // mounted panes (selection + render veto below), but deleting
      // hiddenSince would restart the hysteresis AND desync per-tab deadlines
      // from the worktree retention/TTL clock on every ~3s probe.
      if (isVisible || hasActivityTerminalPortal) {
        terminalTabHiddenSinceRef.current.delete(terminalTab.id)
      } else if (
        !shouldMeasureHiddenWorktree &&
        !terminalTabHiddenSinceRef.current.has(terminalTab.id)
      ) {
        terminalTabHiddenSinceRef.current.set(terminalTab.id, nowMs)
      }
      return {
        id: terminalTab.id,
        ptyId: terminalTab.ptyId,
        activeLeafId: activeLeafIds[index] || null,
        pendingActivationSpawn: terminalTab.pendingActivationSpawn,
        isVisible,
        hasActivityTerminalPortal,
        hiddenSinceMs: terminalTabHiddenSinceRef.current.get(terminalTab.id) ?? null
      }
    })

    const nextColdParkedTerminalTabIds = selectColdParkedTerminalTabs({
      worktreeId,
      worktreeOwner,
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
    setColdParkedTerminalTabIds((current) =>
      haveSameTerminalTabIds(current, parkedTabIds) ? current : parkedTabIds
    )

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
        const tabId = candidate.id
        const timer = window.setTimeout(() => {
          timers.delete(tabId)
          setTerminalTabParkingRevision((revision) => revision + 1)
        }, delayMs)
        timers.set(tabId, timer)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- semantic keys own the tab and assignment dependencies.
  }, [
    activityTerminalPortals,
    isWorktreeActive,
    pendingStartupByTabId,
    runtimeStatusByEnvironmentId,
    shouldMeasureHiddenWorktree,
    terminalParkingEnabled,
    terminalParkAuthorityRevisionKey,
    terminalParkActiveLeafKey,
    terminalSshParkingEnabled,
    terminalTabParkingRevision,
    terminalParkingAssignmentsDependency,
    terminalParkingTabsDependency,
    worktreeId,
    worktreeOwner
  ])

  const evictionExemptTerminalTabIds = useTerminalForceParkExemptTabIds({
    isForceParked,
    tabs: terminalTabs,
    worktreeId,
    worktreeOwner,
    authorityRevisionKey: terminalParkAuthorityRevisionKey
  })

  // Why: the rendered park verdict — worktree-level park (prop from
  // Terminal.tsx) or per-tab cold park, never portal-hosted tabs. Render and
  // the watcher-sync effect must share this exact set so watcher lifecycle
  // tracks the committed unmounts.
  const parkedTerminalTabIds = useMemo(
    () =>
      selectRenderedParkedTerminalTabIds({
        worktreeId,
        terminalTabs,
        assignments,
        isWorktreeActive,
        coldParkTerminalPanes,
        coldParkedTerminalTabIds,
        sleepingRecordOwnedTabIds,
        evictionExemptTerminalTabIds,
        shouldMeasureHiddenWorktree,
        activityTerminalPortals,
        activationDeferredMountTabIds
      }),
    [
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
      worktreeId
    ]
  )

  // Why: observation only — records whether the *rendered* park verdict churns,
  // so a crash bundle can confirm or refute a park-flip update loop. Watching
  // the pre-gate cold set instead would miss loops driven by coldParkTerminalPanes
  // or the portal/measuring gates. Changes no verdict; see
  // terminal-park-verdict-flip-telemetry.ts.
  useEffect(() => {
    recordParkVerdictFlips({
      records: parkVerdictRecordsRef.current,
      liveTabIds: new Set(terminalTabs.map((terminalTab) => terminalTab.id)),
      nextParkedTabIds: parkedTerminalTabIds,
      nowMs: Date.now()
    })
  }, [parkedTerminalTabIds, terminalTabs])

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
