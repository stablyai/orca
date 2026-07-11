import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { PTY_SESSION_ID_SEPARATOR } from '../../../../shared/pty-session-id-format'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { TerminalTab } from '../../../../shared/types'

// Why: cold-park hysteresis keeps a hidden pane mounted for 30s so quick tab
// flips never pay a re-hydrate; hot-retain keeps a bounded recently-visible
// working set warm for 5 minutes beyond that.
export const TERMINAL_WORKTREE_COLD_PARK_DELAY_MS = 30_000
export const TERMINAL_WORKTREE_HOT_RETAIN_MS = 5 * 60_000
export const TERMINAL_WORKTREE_HOT_RETAIN_LIMIT = 4
export const TERMINAL_WORKTREE_PARK_DELAY_MS = TERMINAL_WORKTREE_COLD_PARK_DELAY_MS
export const TERMINAL_TAB_COLD_PARK_DELAY_MS = 30_000
export const TERMINAL_TAB_HOT_RETAIN_MS = 5 * 60_000
export const TERMINAL_TAB_HOT_RETAIN_LIMIT = 12

// Why: tests override these per call (instead of process.env reads inside the
// module) to shrink the 30s hysteresis to test-friendly durations.
export type TerminalColdParkPolicyOverrides = {
  coldParkDelayMs?: number
  hotRetainMs?: number
  hotRetainLimit?: number
}

export type ColdParkableTerminalTab = Pick<TerminalTab, 'id' | 'ptyId' | 'pendingActivationSpawn'>

export type TerminalWorktreeColdParkCandidate = {
  worktreeId: string
  terminalTabs: readonly ColdParkableTerminalTab[]
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  hasActivityTerminalPortal: boolean
  hiddenSinceMs: number | null
}

export type TerminalTabColdParkCandidate = ColdParkableTerminalTab & {
  isVisible: boolean
  hasActivityTerminalPortal: boolean
  hiddenSinceMs: number | null
}

function getPendingActivationSpawnCount(value: boolean | number | undefined): number {
  if (value === true) {
    return 1
  }
  return typeof value === 'number' && value > 0 ? value : 0
}

// Why: parking relies on the daemon model snapshot to re-hydrate. Remote
// runtime and SSH PTYs have no local snapshot in this phase, and a session id
// minted for another worktree reattaches through a path parking cannot replay.
export function isSnapshotBackedTerminalPty(ptyId: string | null, worktreeId: string): boolean {
  if (!ptyId) {
    return false
  }
  if (isRemoteRuntimePtyId(ptyId) || parseAppSshPtyId(ptyId)) {
    return false
  }
  // Why: separator-less ids come from the daemon-fail-open LocalPtyProvider;
  // they have no daemon session model, so revealing a parked pane would
  // silently respawn a fresh shell instead of restoring the snapshot.
  const separatorIdx = ptyId.lastIndexOf(PTY_SESSION_ID_SEPARATOR)
  return separatorIdx !== -1 && ptyId.slice(0, separatorIdx) === worktreeId
}

export function canParkTerminalWorktreeRenderers(args: {
  worktreeId: string
  terminalTabs: readonly ColdParkableTerminalTab[]
  pendingStartupByTabId: Readonly<Record<string, unknown>>
  // Why: callers pass settings.terminalHiddenViewParking !== false — the
  // design-doc kill switch that disables parking entirely.
  parkingEnabled: boolean
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  hasActivityTerminalPortal: boolean
  hiddenSinceMs: number | null
  nowMs: number
  coldParkDelayMs?: number
}): boolean {
  if (
    !args.parkingEnabled ||
    args.isVisible ||
    args.shouldMeasureHiddenWorktree ||
    args.hasActivityTerminalPortal ||
    args.hiddenSinceMs === null
  ) {
    return false
  }
  if (
    args.nowMs - args.hiddenSinceMs <
    (args.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS)
  ) {
    return false
  }
  return args.terminalTabs.every((tab) => {
    if (args.pendingStartupByTabId[tab.id] !== undefined) {
      return false
    }
    if (getPendingActivationSpawnCount(tab.pendingActivationSpawn) > 0) {
      return false
    }
    return isSnapshotBackedTerminalPty(tab.ptyId, args.worktreeId)
  })
}

export function canParkTerminalTabRenderer(args: {
  worktreeId: string
  terminalTab: TerminalTabColdParkCandidate
  pendingStartupByTabId: Readonly<Record<string, unknown>>
  parkingEnabled: boolean
  nowMs: number
  coldParkDelayMs?: number
}): boolean {
  const tab = args.terminalTab
  if (
    !args.parkingEnabled ||
    tab.isVisible ||
    tab.hasActivityTerminalPortal ||
    tab.hiddenSinceMs === null
  ) {
    return false
  }
  if (args.nowMs - tab.hiddenSinceMs < (args.coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS)) {
    return false
  }
  if (args.pendingStartupByTabId[tab.id] !== undefined) {
    return false
  }
  if (getPendingActivationSpawnCount(tab.pendingActivationSpawn) > 0) {
    return false
  }
  return isSnapshotBackedTerminalPty(tab.ptyId, args.worktreeId)
}

type ColdParkRetainCandidate = { id: string; hiddenSinceMs: number }

// Why: hot-retain keeps the most recently hidden ids warm up to the limit;
// ids hidden past hotRetainMs or beyond the limit cold-park. Ties sort by id
// so the selection is deterministic.
function selectIdsBeyondHotRetain(
  candidates: ColdParkRetainCandidate[],
  args: { nowMs: number; hotRetainMs: number; hotRetainLimit: number }
): Set<string> {
  const coldParkedIds = new Set<string>()
  const retainedCandidates: ColdParkRetainCandidate[] = []
  for (const candidate of candidates) {
    if (args.nowMs - candidate.hiddenSinceMs >= args.hotRetainMs) {
      coldParkedIds.add(candidate.id)
    } else {
      retainedCandidates.push(candidate)
    }
  }
  retainedCandidates.sort((a, b) => {
    const recencyDelta = b.hiddenSinceMs - a.hiddenSinceMs
    return recencyDelta === 0 ? a.id.localeCompare(b.id) : recencyDelta
  })
  for (const candidate of retainedCandidates.slice(Math.max(0, args.hotRetainLimit))) {
    coldParkedIds.add(candidate.id)
  }
  return coldParkedIds
}

export function selectColdParkedTerminalWorktrees(
  args: {
    worktrees: readonly TerminalWorktreeColdParkCandidate[]
    pendingStartupByTabId: Readonly<Record<string, unknown>>
    parkingEnabled: boolean
    nowMs: number
  } & TerminalColdParkPolicyOverrides
): Set<string> {
  if (!args.parkingEnabled) {
    return new Set()
  }
  const coldParkDelayMs = args.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS
  const candidates: ColdParkRetainCandidate[] = []
  for (const worktree of args.worktrees) {
    if (
      worktree.hiddenSinceMs === null ||
      !canParkTerminalWorktreeRenderers({
        ...worktree,
        pendingStartupByTabId: args.pendingStartupByTabId,
        parkingEnabled: args.parkingEnabled,
        nowMs: args.nowMs,
        coldParkDelayMs
      })
    ) {
      continue
    }
    candidates.push({ id: worktree.worktreeId, hiddenSinceMs: worktree.hiddenSinceMs })
  }
  return selectIdsBeyondHotRetain(candidates, {
    nowMs: args.nowMs,
    hotRetainMs: args.hotRetainMs ?? TERMINAL_WORKTREE_HOT_RETAIN_MS,
    hotRetainLimit: args.hotRetainLimit ?? TERMINAL_WORKTREE_HOT_RETAIN_LIMIT
  })
}

export function selectColdParkedTerminalTabs(
  args: {
    worktreeId: string
    terminalTabs: readonly TerminalTabColdParkCandidate[]
    pendingStartupByTabId: Readonly<Record<string, unknown>>
    parkingEnabled: boolean
    nowMs: number
  } & TerminalColdParkPolicyOverrides
): Set<string> {
  if (!args.parkingEnabled) {
    return new Set()
  }
  const coldParkDelayMs = args.coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS
  const candidates: ColdParkRetainCandidate[] = []
  for (const tab of args.terminalTabs) {
    if (
      tab.hiddenSinceMs === null ||
      !canParkTerminalTabRenderer({
        worktreeId: args.worktreeId,
        terminalTab: tab,
        pendingStartupByTabId: args.pendingStartupByTabId,
        parkingEnabled: args.parkingEnabled,
        nowMs: args.nowMs,
        coldParkDelayMs
      })
    ) {
      continue
    }
    candidates.push({ id: tab.id, hiddenSinceMs: tab.hiddenSinceMs })
  }
  return selectIdsBeyondHotRetain(candidates, {
    nowMs: args.nowMs,
    hotRetainMs: args.hotRetainMs ?? TERMINAL_TAB_HOT_RETAIN_MS,
    hotRetainLimit: args.hotRetainLimit ?? TERMINAL_TAB_HOT_RETAIN_LIMIT
  })
}

// Why: parking decisions change only at the cold-park and hot-retain
// deadlines, so callers schedule one recheck at the next deadline instead of
// polling.
function nextColdParkDeadlineDelayMs(args: {
  parkingEnabled: boolean
  hiddenSinceMs: number | null
  nowMs: number
  coldParkDelayMs: number
  hotRetainMs: number
}): number | null {
  if (!args.parkingEnabled || args.hiddenSinceMs === null) {
    return null
  }
  const pendingDeadlines = [
    args.hiddenSinceMs + args.coldParkDelayMs,
    args.hiddenSinceMs + args.hotRetainMs
  ].filter((deadlineMs) => deadlineMs > args.nowMs)
  return pendingDeadlines.length === 0 ? null : Math.min(...pendingDeadlines) - args.nowMs
}

export function getTerminalWorktreeColdParkRecheckDelayMs(args: {
  parkingEnabled: boolean
  hiddenSinceMs: number | null
  nowMs: number
  coldParkDelayMs?: number
  hotRetainMs?: number
}): number | null {
  return nextColdParkDeadlineDelayMs({
    parkingEnabled: args.parkingEnabled,
    hiddenSinceMs: args.hiddenSinceMs,
    nowMs: args.nowMs,
    coldParkDelayMs: args.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
    hotRetainMs: args.hotRetainMs ?? TERMINAL_WORKTREE_HOT_RETAIN_MS
  })
}

export function getTerminalTabColdParkRecheckDelayMs(args: {
  parkingEnabled: boolean
  hiddenSinceMs: number | null
  nowMs: number
  coldParkDelayMs?: number
  hotRetainMs?: number
}): number | null {
  return nextColdParkDeadlineDelayMs({
    parkingEnabled: args.parkingEnabled,
    hiddenSinceMs: args.hiddenSinceMs,
    nowMs: args.nowMs,
    coldParkDelayMs: args.coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS,
    hotRetainMs: args.hotRetainMs ?? TERMINAL_TAB_HOT_RETAIN_MS
  })
}
