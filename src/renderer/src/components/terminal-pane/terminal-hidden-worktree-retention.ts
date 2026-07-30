import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import {
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
  normalizeDesktopTerminalScrollbackRows
} from '../../../../shared/terminal-scrollback-policy'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import {
  TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
  isSnapshotBackedTerminalPty,
  type TerminalColdParkPolicyOverrides
} from './terminal-hidden-view-parking'
import { collectLeafIdsInOrder } from './terminal-layout-leaf-ids'

// Why these sizes: a retained hidden pane costs a measured ~2.5MB of V8 heap
// at the 5k-row default scrollback and ~19MB at 50k (plus per-pane queues),
// not the ~4-5MB per WORKTREE the warm cap assumed. Un-parkable worktrees
// therefore share 12 default-scrollback pane units while hidden; split panes,
// tabs, and larger scrollback all spend that budget. Newer worktrees claim
// capacity first, candidates that do not fit force-park, and none survive past
// 45 minutes. The newest candidate stays warm only when it fits.
// NOT covered by this bound: eviction-exempt TABS (isEvictionExemptTerminalPty
// — live local ptys a remount would respawn, orphaning the shell). Their panes
// stay mounted through a force-park at any age, so a fleet-wide daemon
// fail-open can leave the budget freeing nothing; Terminal.tsx logs that
// degenerate case rather than pretending the bound held.
// Scrollback is weighted instead of demoted: a 50k pane spends 10 units.
export const TERMINAL_HIDDEN_PANE_RETENTION_LIMIT = 12
export const TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS = 45 * 60_000

export function countTerminalLayoutPanes(layout: TerminalLayoutSnapshot | undefined): number {
  return Math.max(
    1,
    collectLeafIdsInOrder(layout?.root).length,
    Object.keys(layout?.ptyIdsByLeafId ?? {}).length
  )
}

type TerminalLayoutPaneCountState = {
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
}

let cachedTerminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> | null = null
let cachedTerminalLayoutPaneCountByTabId: Readonly<Record<string, number>> = {}

export function selectTerminalLayoutPaneCountByTabId(
  state: TerminalLayoutPaneCountState
): Readonly<Record<string, number>> {
  if (state.terminalLayoutsByTabId === cachedTerminalLayoutsByTabId) {
    return cachedTerminalLayoutPaneCountByTabId
  }
  const next = Object.fromEntries(
    Object.entries(state.terminalLayoutsByTabId).map(([tabId, layout]) => [
      tabId,
      countTerminalLayoutPanes(layout)
    ])
  )
  const nextKeys = Object.keys(next)
  if (
    Object.keys(cachedTerminalLayoutPaneCountByTabId).length !== nextKeys.length ||
    nextKeys.some((tabId) => cachedTerminalLayoutPaneCountByTabId[tabId] !== next[tabId])
  ) {
    cachedTerminalLayoutPaneCountByTabId = next
  }
  cachedTerminalLayoutsByTabId = state.terminalLayoutsByTabId
  return cachedTerminalLayoutPaneCountByTabId
}

export function getTerminalHiddenPaneRetentionWeight(
  retainedPaneCount: number,
  scrollbackRows: unknown
): number {
  const paneCount = Number.isFinite(retainedPaneCount)
    ? Math.max(1, Math.floor(retainedPaneCount))
    : 1
  const rowWeight = Math.ceil(
    normalizeDesktopTerminalScrollbackRows(scrollbackRows) /
      DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
  )
  return paneCount * rowWeight
}

// Why: an eviction-exempt pty is a live local one a remount could not reattach
// (daemon-fail-open separator-less ids, ptys minted under another worktree) — a
// fresh spawn would orphan the live shell. Its TAB keeps its mounted pane when
// the worktree force-parks (per-tab exclusion, mirroring Activity portals).
// Per-PTY, not per-tab: the coverage veto that makes a worktree a retention
// candidate walks every split pane, so the exemption must too (see
// isEvictionExemptTerminalTab).
export function isEvictionExemptTerminalPty(
  ptyId: string | null | undefined,
  worktreeId: string
): boolean {
  if (!ptyId || isRemoteRuntimePtyId(ptyId) || parseAppSshPtyId(ptyId)) {
    return false
  }
  return !isSnapshotBackedTerminalPty(ptyId, worktreeId)
}

export type TerminalWorktreeRetentionCandidate = {
  worktreeId: string
  hiddenSinceMs: number | null
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  hasActivityTerminalPortal: boolean
  /** Post-measure cool-down (see TerminalWorktreeColdParkCandidate): force-park
   *  must not re-engage right after a measure window ends, but hiddenSince —
   *  and with it the TTL/ranking clock — stays untouched. */
  parkCooldownUntilMs?: number | null
  /** Ordinary cold parking can evict this worktree (park-eligible AND watcher-coverable) — the warm cap bounds it already. */
  ordinaryParkingCovers: boolean
  /** Pending startup or activation spawn — a mount is imminent; never evict. */
  hasPendingSpawnWork: boolean
  /** Mounted renderer burden represented by the persisted tab/split topology. */
  retainedPaneCount: number
}

/**
 * Retention budget over the worktrees ordinary parking can never evict: hidden
 * pane weight beyond the retention limit, or any worktree past TTL, force-parks —
 * panes unmount, watchers cover the tabs whose transport exists, and reveal
 * restores per pty class (the app-restart experience). Eviction-exempt tabs
 * do NOT veto the worktree: they keep their mounted panes via the per-tab
 * exclusion (Activity-portal pattern) while sibling tabs unmount, so one
 * exempt tab can no longer pin co-located remote-runtime tabs forever.
 * Newest candidates claim the pane/scrollback budget first, deterministic ties
 * break by id, and an individually-overweight newest candidate force-parks
 * instead of defeating the bound. Older candidates may use capacity left by a
 * newer candidate that did not fit.
 */
export function selectRetentionForceParkedTerminalWorktrees(
  args: {
    worktrees: readonly TerminalWorktreeRetentionCandidate[]
    parkingEnabled: boolean
    retentionBudgetEnabled: boolean
    nowMs: number
    scrollbackRows?: number
  } & TerminalColdParkPolicyOverrides
): Set<string> {
  if (!args.parkingEnabled || !args.retentionBudgetEnabled) {
    return new Set()
  }
  const coldParkDelayMs = args.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS
  const retentionTtlMs = args.retentionTtlMs ?? TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS
  const forceParkedIds = new Set<string>()
  const retainedCandidates: {
    id: string
    hiddenSinceMs: number
    weight: number
  }[] = []
  for (const worktree of args.worktrees) {
    if (
      worktree.hiddenSinceMs === null ||
      worktree.isVisible ||
      worktree.shouldMeasureHiddenWorktree ||
      worktree.hasActivityTerminalPortal ||
      worktree.ordinaryParkingCovers ||
      worktree.hasPendingSpawnWork ||
      (worktree.parkCooldownUntilMs != null && args.nowMs < worktree.parkCooldownUntilMs) ||
      args.nowMs - worktree.hiddenSinceMs < coldParkDelayMs
    ) {
      continue
    }
    if (args.nowMs - worktree.hiddenSinceMs >= retentionTtlMs) {
      forceParkedIds.add(worktree.worktreeId)
      continue
    }
    retainedCandidates.push({
      id: worktree.worktreeId,
      hiddenSinceMs: worktree.hiddenSinceMs,
      weight: getTerminalHiddenPaneRetentionWeight(worktree.retainedPaneCount, args.scrollbackRows)
    })
  }
  retainedCandidates.sort((left, right) => {
    const recencyDelta = right.hiddenSinceMs - left.hiddenSinceMs
    return recencyDelta === 0 ? left.id.localeCompare(right.id) : recencyDelta
  })
  const retentionLimit = Math.max(0, args.retentionLimit ?? TERMINAL_HIDDEN_PANE_RETENTION_LIMIT)
  let retainedWeight = 0
  for (const candidate of retainedCandidates) {
    if (retainedWeight + candidate.weight <= retentionLimit) {
      retainedWeight += candidate.weight
    } else {
      forceParkedIds.add(candidate.id)
    }
  }
  return forceParkedIds
}

// Why exported: an all-exempt force-park frees nothing, and that degenerate
// case is only observable if the empty selection is a value the host can test.
export function selectForceParkEvictableTabIds<T extends { id: string }>(
  tabs: readonly T[],
  isExempt: (tab: T) => boolean
): string[] {
  return tabs.filter((tab) => !isExempt(tab)).map((tab) => tab.id)
}
