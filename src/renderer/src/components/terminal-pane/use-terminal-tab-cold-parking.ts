/**
 * Per-tab hidden-view parking for TerminalPaneOverlayLayer.
 *
 * Why: owns the cold-park policy bookkeeping (hiddenSince tracking, recheck
 * timers, parked-set selection) and the parked byte-watcher reconciliation so
 * the overlay layer only consumes the final parked tab set when deciding to
 * render a slot as null. See docs/reference/terminal-hidden-view-parking.md.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalTab } from '../../../../shared/types'
import { useAppStore } from '../../store'
import {
  findActivityTerminalPortal,
  type ActivityTerminalPortalTarget
} from '../activity/activity-terminal-portal'
import {
  getTerminalTabColdParkRecheckDelayMs,
  selectColdParkedTerminalTabs,
  type TerminalTabColdParkCandidate
} from './terminal-hidden-view-parking'
import { getTerminalParkingPolicyOverrides } from './terminal-parking-e2e-overrides'
import {
  canWatcherCoverParkedTerminalTab,
  disposeParkedTerminalWatchersForWorktree,
  syncParkedTerminalTabWatchers
} from './terminal-parked-tab-watchers'

type TerminalOverlayTabAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

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
  /** Hidden-measuring startup probe from Terminal.tsx — the panes must stay
   *  mounted for their first xterm fit, mirroring the worktree-level guard. */
  shouldMeasureHiddenWorktree: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
}): ReadonlySet<string> {
  const {
    worktreeId,
    terminalTabs,
    assignments,
    isWorktreeActive,
    coldParkTerminalPanes,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals
  } = args
  const pendingStartupByTabId = useAppStore((state) => state.pendingStartupByTabId)
  const terminalParkingEnabled = useAppStore(
    (state) => state.settings?.terminalHiddenViewParking !== false
  )
  const terminalTabHiddenSinceRef = useRef(new Map<string, number>())
  const terminalTabParkingTimersRef = useRef(new Map<string, number>())
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

    const candidates: TerminalTabColdParkCandidate[] = terminalTabs.map((terminalTab) => {
      const assignment = assignments.get(terminalTab.id)
      const isVisible = Boolean(isWorktreeActive && assignment && assignment.isActiveInGroup)
      const hasActivityTerminalPortal = portalTabIds.has(terminalTab.id)
      // Why: hidden-measuring counts as visibility — the startup probe needs
      // mounted panes, so the hidden clock must not run during it.
      if (isVisible || hasActivityTerminalPortal || shouldMeasureHiddenWorktree) {
        terminalTabHiddenSinceRef.current.delete(terminalTab.id)
      } else if (!terminalTabHiddenSinceRef.current.has(terminalTab.id)) {
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
    shouldMeasureHiddenWorktree,
    terminalParkingEnabled,
    terminalTabParkingRevision,
    terminalTabs,
    worktreeId
  ])

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
        // Why: the hidden-measuring startup probe needs mounted panes; gate
        // here too so the reveal lands in the same render that starts it.
        !shouldMeasureHiddenWorktree
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
    isWorktreeActive,
    shouldMeasureHiddenWorktree,
    terminalTabs,
    worktreeId
  ])

  // Why: runs in the same effect flush as the commit that parked/revealed the
  // panes — watcher disposal therefore lands before any PTY data IPC can
  // reach a freshly remounted pane, and watcher start lands after the parked
  // pane's unmount capture.
  useEffect(() => {
    syncParkedTerminalTabWatchers({
      worktreeId,
      tabs: terminalTabs,
      parkedTabIds: parkedTerminalTabIds
    })
  }, [parkedTerminalTabIds, terminalTabs, worktreeId])

  useEffect(() => () => disposeParkedTerminalWatchersForWorktree(worktreeId), [worktreeId])

  return parkedTerminalTabIds
}
