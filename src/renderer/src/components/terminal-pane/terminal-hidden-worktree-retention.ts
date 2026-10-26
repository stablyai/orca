import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { isRemoteExecutionHostPtyId } from '../../../../shared/remote-execution-host-pty-id'
import { PTY_SESSION_ID_SEPARATOR } from '../../../../shared/pty-session-id-format'
import { terminalProviderHasAuthoritativeSnapshot } from '../terminal/terminal-provider-snapshot-capability'
import {
  TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
  selectIdsBeyondHotRetain,
  type ColdParkRetainCandidate,
  type TerminalColdParkPolicyOverrides
} from './terminal-hidden-view-parking'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { createWorktreeTabBucketProjection } from '@/lib/worktree-tab-bucket-projection'

// Budget hidden worktrees by count and absolute TTL: measured pane heap grows with scrollback. Last-active exempts only the cap; unrestorable live tabs must remain mounted, and scrollback depth is unbounded, so force-park may free nothing.
export const TERMINAL_HIDDEN_WORKTREE_RETENTION_LIMIT = 4
export const TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS = 15 * 60_000

export function createTerminalWorktreeTopologyProjection(
  onInspectBucket?: (worktreeId: string) => void
) {
  return createWorktreeTabBucketProjection<TerminalTab, TerminalTab>({
    projectTab: (tab) => tab,
    isSameProjectedTab: (previousTab, nextTab) =>
      previousTab.id === nextTab.id &&
      previousTab.ptyId === nextTab.ptyId &&
      previousTab.worktreeId === nextTab.worktreeId &&
      previousTab.pendingActivationSpawn === nextTab.pendingActivationSpawn &&
      previousTab.generation === nextTab.generation &&
      previousTab.startupCwd === nextTab.startupCwd,
    onInspectBucket
  })
}

export function hasPendingRetentionSpawnWork(
  tab: Pick<TerminalTab, 'id' | 'ptyId' | 'pendingActivationSpawn'>,
  pendingStartupByTabId: Readonly<Record<string, unknown>>
): boolean {
  if (pendingStartupByTabId[tab.id] !== undefined) {
    return true
  }
  // Paired mirrors never spawn locally; their host PTY proves activation-suppression residue is finished.
  return Boolean(tab.pendingActivationSpawn && (!tab.ptyId || !isRemoteRuntimePtyId(tab.ptyId)))
}

// Unrestorable live local PTYs keep their tab mounted through force-park; check every split, matching watcher coverage.
export function isEvictionExemptTerminalPty(
  ptyId: string | null | undefined,
  worktreeId: string
): boolean {
  return classifyEvictionExemptTerminalPty(ptyId, worktreeId) !== null
}

export type EvictionExemptTerminalPtyRoute = 'fail-open' | 'foreign-worktree' | 'capability-unknown'

// Route counts distinguish daemon fail-open from unknown snapshot capability when all-exempt force-park frees nothing.
export function classifyEvictionExemptTerminalPty(
  ptyId: string | null | undefined,
  worktreeId: string
): EvictionExemptTerminalPtyRoute | null {
  if (!ptyId || isRemoteExecutionHostPtyId(ptyId)) {
    return null
  }
  const separatorIdx = ptyId.lastIndexOf(PTY_SESSION_ID_SEPARATOR)
  if (separatorIdx === -1) {
    return 'fail-open'
  }
  if (ptyId.slice(0, separatorIdx) !== worktreeId) {
    return 'foreign-worktree'
  }
  return terminalProviderHasAuthoritativeSnapshot(ptyId) ? null : 'capability-unknown'
}

export type EvictionExemptRouteCounts = {
  failOpen: number
  foreignWorktree: number
  capabilityUnknown: number
  /** Tab-level pty classifies clean, so the exemption came from a split pane's pty. */
  splitPane: number
}

export function countEvictionExemptTabRoutes(
  tabs: readonly Pick<TerminalTab, 'ptyId'>[],
  worktreeId: string
): EvictionExemptRouteCounts {
  const counts: EvictionExemptRouteCounts = {
    failOpen: 0,
    foreignWorktree: 0,
    capabilityUnknown: 0,
    splitPane: 0
  }
  for (const tab of tabs) {
    switch (classifyEvictionExemptTerminalPty(tab.ptyId, worktreeId)) {
      case 'fail-open':
        counts.failOpen += 1
        break
      case 'foreign-worktree':
        counts.foreignWorktree += 1
        break
      case 'capability-unknown':
        counts.capabilityUnknown += 1
        break
      case null:
        counts.splitPane += 1
        break
    }
  }
  return counts
}

export function formatEvictionExemptRouteCounts(counts: EvictionExemptRouteCounts): string {
  return `routes=fail-open:${counts.failOpen},foreign:${counts.foreignWorktree},capability:${counts.capabilityUnknown},split-pane:${counts.splitPane}`
}

export type TerminalWorktreeRetentionCandidate = {
  worktreeId: string
  hiddenSinceMs: number | null
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  hasActivityTerminalPortal: boolean
  /** Measure preserves TTL/rank age; cool-down prevents force-park immediately after its lease ends. */
  parkCooldownUntilMs?: number | null
  /** Ordinary cold parking can evict this worktree (park-eligible AND watcher-coverable) — the warm cap bounds it already. */
  ordinaryParkingCovers: boolean
  /** Pending startup or activation spawn — a mount is imminent; never evict. */
  hasPendingSpawnWork: boolean
}

/** Force-park hidden worktrees ordinary parking cannot evict when over count/TTL. Exempt tabs stay mounted while siblings unmount. Reuse deterministic warm ranking, but override last-active’s clock exemption so TTL remains absolute. */
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
  // Warm ranking spares last-active from time too; reapply absolute retention TTL to avoid indefinite mounting.
  for (const candidate of candidates) {
    if (args.nowMs - candidate.hiddenSinceMs >= retentionTtlMs) {
      forceParkedIds.add(candidate.id)
    }
  }
  return forceParkedIds
}

// Expose empty selections so all-exempt force-parks that free nothing remain observable/testable.
export function selectForceParkEvictableTabIds<T extends { id: string }>(
  tabs: readonly T[],
  isExempt: (tab: T) => boolean
): string[] {
  return tabs.filter((tab) => !isExempt(tab)).map((tab) => tab.id)
}
