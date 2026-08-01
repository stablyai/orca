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
import {
  findActivityTerminalPortal,
  type ActivityTerminalPortalTarget
} from '../activity/activity-terminal-portal'
import { getTerminalTabColdParkRecheckDelayMs } from './terminal-cold-park-recheck-deadlines'
import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  selectPairedRuntimeParkingEnvironmentIds,
  selectColdParkedTerminalTabs,
  type TerminalTabColdParkCandidate
} from './terminal-hidden-view-parking'
import {
  recordParkVerdictFlips,
  type ParkVerdictFlipRecord
} from './terminal-park-verdict-flip-telemetry'
import { getTerminalParkingPolicyOverrides } from './terminal-parking-e2e-overrides'
import {
  selectEvictionExemptTerminalTabIds,
  selectEvictionExemptTerminalTabLayoutKey
} from './terminal-eviction-exempt-tabs'
import {
  canWatcherCoverParkedTerminalTab,
  disposeParkedTerminalWatchersForWorktree,
  syncParkedTerminalTabWatchers
} from './terminal-parked-tab-watchers'

type TerminalOverlayTabAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()

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

    const candidates: TerminalTabColdParkCandidate[] = terminalTabs.map((terminalTab) => {
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
        pendingActivationSpawn: terminalTab.pendingActivationSpawn,
        isVisible,
        hasActivityTerminalPortal,
        hiddenSinceMs: terminalTabHiddenSinceRef.current.get(terminalTab.id) ?? null
      }
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
    // Why: a tab the byte watchers cannot cover (no capture, no layout
    // snapshot, legacy leaf ids) must never park — it would go silent for
    // bells/titles/completions, the failure that sank the first attempt.
    for (const terminalTab of terminalTabs) {
      if (
        nextColdParkedTerminalTabIds.has(terminalTab.id) &&
        !canWatcherCoverParkedTerminalTab(worktreeId, terminalTab)
      ) {
        nextColdParkedTerminalTabIds.delete(terminalTab.id)
      }
    }
    setColdParkedTerminalTabIds((current) =>
      haveSameTerminalTabIds(current, nextColdParkedTerminalTabIds)
        ? current
        : nextColdParkedTerminalTabIds
    )

    for (const candidate of candidates) {
      if (
        candidate.isVisible ||
        candidate.hasActivityTerminalPortal ||
        nextColdParkedTerminalTabIds.has(candidate.id)
      ) {
        continue
      }
      const delayMs = getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: terminalParkingEnabled,
        hiddenSinceMs: candidate.hiddenSinceMs,
        parkCooldownUntilMs: measureParkCooldownUntilRef.current,
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
  }, [
    activityTerminalPortals,
    assignments,
    isWorktreeActive,
    pendingStartupByTabId,
    pairedRuntimeParkingEnvironmentIds,
    shouldMeasureHiddenWorktree,
    terminalParkingEnabled,
    terminalSshParkingEnabled,
    terminalTabParkingRevision,
    terminalTabs,
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

  // Why: the rendered park verdict — worktree-level park (prop from
  // Terminal.tsx) or per-tab cold park, never portal-hosted tabs. Render and
  // the watcher-sync effect must share this exact set so watcher lifecycle
  // tracks the committed unmounts.
  const parkedTerminalTabIds = useMemo(() => {
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
        (coldParkTerminalPanes || (!isVisible && coldParkedTerminalTabIds.has(terminalTab.id))) &&
        !hasActivityTerminalPortal &&
        // Why: a force-parked worktree's eviction-exempt tabs keep their
        // mounted panes — a remount would orphan their live pty. Scoped to
        // force-parks: ordinary parks never contain exempt tabs (eligibility
        // requires every tab restorable, so the memo is empty for them).
        !evictionExemptTerminalTabIds.has(terminalTab.id) &&
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
    terminalTabs,
    worktreeId
  ])

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
  useEffect(() => {
    syncParkedTerminalTabWatchers({
      worktreeId,
      tabs: terminalTabs,
      parkedTabIds: parkedTerminalTabIds,
      // Why: activation-deferred tabs have no prior pane-owned title slot;
      // pull main's title-only snapshot when their watcher starts.
      restoreTitleOnStartTabIds: activationDeferredMountTabIds ?? undefined
    })
  }, [activationDeferredMountTabIds, parkedTerminalTabIds, terminalTabs, worktreeId])

  useEffect(() => () => disposeParkedTerminalWatchersForWorktree(worktreeId), [worktreeId])

  return parkedTerminalTabIds
}
