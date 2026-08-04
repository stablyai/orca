import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { terminalProviderHasAuthoritativeSnapshot } from '../terminal/terminal-provider-snapshot-capability'
import {
  TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
  isSnapshotBackedTerminalPty,
  selectIdsBeyondHotRetain,
  type ColdParkRetainCandidate,
  type TerminalColdParkPolicyOverrides
} from './terminal-hidden-view-parking'
import type { TerminalTab } from '../../../../shared/types'

// Why these sizes: a retained hidden pane costs a measured ~2.5MB of V8 heap
// at the 5k-row default scrollback and ~19MB at 50k (plus per-pane queues),
// not the ~4-5MB per WORKTREE the warm cap assumed — so un-parkable worktrees
// (pty classes parking can't restore) get a retention budget: at most 12 stay
// mounted while hidden and none past 45 minutes, evicted least-recently-hidden
// first via force-park. The TTL is absolute: the last-active exemption bounds
// the cap, never the clock.
// NOT covered by this bound: eviction-exempt TABS (isEvictionExemptTerminalPty
// — live local ptys a remount would respawn, orphaning the shell). Their panes
// stay mounted through a force-park at any age, so a fleet-wide daemon
// fail-open can leave the budget freeing nothing; Terminal.tsx logs that
// degenerate case rather than pretending the bound held.
// Also NOT covered: per-pane scrollback size. Hidden-pane scrollback demotion
// was intentionally removed — the bound is worktree count + TTL only, so a
// spared worktree (last-active, exempt tabs) can hold full 50k-row scrollback
// indefinitely. Accepted tradeoff: high-scrollback users rely on unmount
// eviction, not demotion.
export const TERMINAL_HIDDEN_WORKTREE_RETENTION_LIMIT = 12
export const TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS = 45 * 60_000

export function hasPendingRetentionSpawnWork(
  tab: Pick<TerminalTab, 'id' | 'ptyId' | 'pendingActivationSpawn'>,
  pendingStartupByTabId: Readonly<Record<string, unknown>>
): boolean {
  if (pendingStartupByTabId[tab.id] !== undefined) {
    return true
  }
  // Why: paired mirrors never spawn locally; their host-backed PTY id proves
  // activation's sort-suppression residue cannot represent unfinished work.
  return Boolean(tab.pendingActivationSpawn && (!tab.ptyId || !isRemoteRuntimePtyId(tab.ptyId)))
}

// Why: an eviction-exempt pty is a live local one a remount cannot restore
// faithfully (daemon-fail-open/foreign ids or a preserved legacy daemon). Its
// TAB keeps its mounted pane when the worktree force-parks.
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
  return (
    !isSnapshotBackedTerminalPty(ptyId, worktreeId) ||
    !terminalProviderHasAuthoritativeSnapshot(ptyId)
  )
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
}

/**
 * Retention budget over the worktrees ordinary parking can never evict: any
 * hidden un-parkable worktree beyond the retention limit or TTL force-parks —
 * panes unmount, watchers cover the tabs whose transport exists, and reveal
 * restores per pty class (the app-restart experience). Eviction-exempt tabs
 * do NOT veto the worktree: they keep their mounted panes via the per-tab
 * exclusion (Activity-portal pattern) while sibling tabs unmount, so one
 * exempt tab can no longer pin co-located remote-runtime tabs forever.
 * Ranking reuses the hot-retain machinery, so deterministic ties hold here too,
 * and the verdict changes only at deadlines or on real state transitions (no
 * new flip-loop inputs). The last-active exemption it carries spares one
 * worktree from the CAP only — the TTL below overrides it, else a lone hidden
 * un-parkable worktree would stay mounted for the whole session.
 */
export function selectRetentionForceParkedTerminalWorktrees(
  args: {
    worktrees: readonly TerminalWorktreeRetentionCandidate[]
    parkingEnabled: boolean
    retentionBudgetEnabled: boolean
    nowMs: number
  } & TerminalColdParkPolicyOverrides
): Set<string> {
  if (!args.parkingEnabled || !args.retentionBudgetEnabled) {
    return new Set()
  }
  const coldParkDelayMs = args.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS
  const candidates: ColdParkRetainCandidate[] = []
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
    candidates.push({ id: worktree.worktreeId, hiddenSinceMs: worktree.hiddenSinceMs })
  }
  const retentionTtlMs = args.retentionTtlMs ?? TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS
  const forceParkedIds = selectIdsBeyondHotRetain(candidates, {
    nowMs: args.nowMs,
    hotRetainMs: retentionTtlMs,
    hotRetainLimit: args.retentionLimit ?? TERMINAL_HIDDEN_WORKTREE_RETENTION_LIMIT
  })
  // Why re-applied here: selectIdsBeyondHotRetain spares the last-active id from
  // its clock too, which is right for the warm cap (instant return after a
  // meeting) but makes "none past 45 minutes" false for a lone hidden worktree.
  for (const candidate of candidates) {
    if (args.nowMs - candidate.hiddenSinceMs >= retentionTtlMs) {
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
