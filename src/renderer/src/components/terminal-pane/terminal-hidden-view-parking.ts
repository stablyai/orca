import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { PTY_SESSION_ID_SEPARATOR } from '../../../../shared/pty-session-id-format'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { TerminalTab } from '../../../../shared/types'

// Why: cold-park hysteresis keeps a hidden pane mounted for 30s so quick tab
// flips never pay a re-hydrate; hot-retain keeps a bounded recently-visible
// working set warm for 5 minutes beyond that. The cap (not the clock) is the
// primary evictor — 4 worktrees covers the ordinary working set, so parking
// only engages for the many-worktree tail it
// was built for. Reveal cost is a flat ~170ms remount regardless of buffer
// size, so cutting remount *frequency* beats shaving replay.
export const TERMINAL_WORKTREE_COLD_PARK_DELAY_MS = 30_000
export const TERMINAL_WORKTREE_HOT_RETAIN_MS = 5 * 60_000
export const TERMINAL_WORKTREE_HOT_RETAIN_LIMIT = 4
export const TERMINAL_WORKTREE_PARK_DELAY_MS = TERMINAL_WORKTREE_COLD_PARK_DELAY_MS
export const TERMINAL_TAB_COLD_PARK_DELAY_MS = 30_000
export const TERMINAL_TAB_HOT_RETAIN_MS = 5 * 60_000
export const TERMINAL_TAB_HOT_RETAIN_LIMIT = 6

// Why: tests override these per call (instead of process.env reads inside the
// module) to shrink the 30s hysteresis to test-friendly durations.
export type TerminalColdParkPolicyOverrides = {
  coldParkDelayMs?: number
  hotRetainMs?: number
  hotRetainLimit?: number
  retentionTtlMs?: number
  retentionLimit?: number
}

export type ColdParkableTerminalTab = Pick<TerminalTab, 'id' | 'ptyId' | 'pendingActivationSpawn'>

export type TerminalWorktreeColdParkCandidate = {
  worktreeId: string
  terminalTabs: readonly ColdParkableTerminalTab[]
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  hasActivityTerminalPortal: boolean
  hiddenSinceMs: number | null
  /** Post-measure cool-down: hiddenSince survives a measure window (TTL/rank
   *  clock stays honest), but re-park waits for this deadline — else every ~3s
   *  measure lease on a past-deadline worktree thrashes remount → re-park. */
  parkCooldownUntilMs?: number | null
}

export type TerminalTabColdParkCandidate = ColdParkableTerminalTab & {
  isVisible: boolean
  hasActivityTerminalPortal: boolean
  hiddenSinceMs: number | null
  /** Higher means activated more recently; breaks same-pass hidden-time ties. */
  lastActivatedSeq?: number
}

function getPendingActivationSpawnCount(value: boolean | number | undefined): number {
  if (value === true) {
    return 1
  }
  return typeof value === 'number' && value > 0 ? value : 0
}

function hasPendingActivationSpawn(tab: ColdParkableTerminalTab): boolean {
  return (
    getPendingActivationSpawnCount(tab.pendingActivationSpawn) > 0 &&
    (!tab.ptyId || !isRemoteRuntimePtyId(tab.ptyId))
  )
}

// Why: snapshot-backed = local daemon session owned by this worktree (foreign
// ids reattach through a path parking cannot replay). SSH is restorable too,
// via isParkRestorableTerminalPty + main's headless model; only remote-runtime
// ptys, which never transit main, stay unrestorable.
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

export type TerminalParkRestorePolicy = {
  /** settings.terminalSshViewParking !== false — the C1 SSH-parking kill switch. */
  sshParkingEnabled?: boolean
  /** Exact paired environments whose host advertises bounded snapshot restore. */
  pairedRuntimeParkingEnvironmentIds?: ReadonlySet<string>
}

export function selectPairedRuntimeParkingEnvironmentIds(
  statuses: ReadonlyMap<string, { status: { capabilities?: readonly string[] } | null | undefined }>
): Set<string> {
  const capable = new Set<string>()
  for (const [environmentId, entry] of statuses) {
    if (entry.status?.capabilities?.includes(TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY)) {
      capable.add(environmentId)
    }
  }
  return capable
}

// Why: SSH uses local main's model; paired PTYs are eligible only when their
// exact host advertises authoritative bounded restore.
export function isParkRestorableTerminalPty(
  ptyId: string | null,
  worktreeId: string,
  policy?: TerminalParkRestorePolicy
): boolean {
  if (isSnapshotBackedTerminalPty(ptyId, worktreeId)) {
    return true
  }
  if (ptyId && isRemoteRuntimePtyId(ptyId)) {
    const environmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
    return (
      environmentId !== null &&
      policy?.pairedRuntimeParkingEnvironmentIds?.has(environmentId) === true
    )
  }
  return policy?.sshParkingEnabled === true && ptyId !== null && parseAppSshPtyId(ptyId) !== null
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
  parkCooldownUntilMs?: number | null
  nowMs: number
  coldParkDelayMs?: number
  restorePolicy?: TerminalParkRestorePolicy
}): boolean {
  if (
    !args.parkingEnabled ||
    args.isVisible ||
    args.shouldMeasureHiddenWorktree ||
    args.hasActivityTerminalPortal ||
    args.hiddenSinceMs === null ||
    (args.parkCooldownUntilMs != null && args.nowMs < args.parkCooldownUntilMs)
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
    if (hasPendingActivationSpawn(tab)) {
      return false
    }
    return isParkRestorableTerminalPty(tab.ptyId, args.worktreeId, args.restorePolicy)
  })
}

export function canParkTerminalTabRenderer(args: {
  worktreeId: string
  terminalTab: TerminalTabColdParkCandidate
  pendingStartupByTabId: Readonly<Record<string, unknown>>
  parkingEnabled: boolean
  nowMs: number
  coldParkDelayMs?: number
  /** Worktree-scoped post-measure cool-down (measure windows are per-worktree). */
  parkCooldownUntilMs?: number | null
  restorePolicy?: TerminalParkRestorePolicy
}): boolean {
  const tab = args.terminalTab
  if (
    !args.parkingEnabled ||
    tab.isVisible ||
    tab.hasActivityTerminalPortal ||
    tab.hiddenSinceMs === null ||
    (args.parkCooldownUntilMs != null && args.nowMs < args.parkCooldownUntilMs)
  ) {
    return false
  }
  if (args.nowMs - tab.hiddenSinceMs < (args.coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS)) {
    return false
  }
  if (args.pendingStartupByTabId[tab.id] !== undefined) {
    return false
  }
  if (hasPendingActivationSpawn(tab)) {
    return false
  }
  return isParkRestorableTerminalPty(tab.ptyId, args.worktreeId, args.restorePolicy)
}

export type ColdParkRetainCandidate = {
  id: string
  hiddenSinceMs: number
  lastActivatedSeq?: number
}

// Why: a view switch stamps every owned tab at once, so activation order must
// break the routine hidden-time tie before the deterministic UUID fallback.
function compareColdParkRecencyDesc(
  a: ColdParkRetainCandidate,
  b: ColdParkRetainCandidate
): number {
  if (a.hiddenSinceMs !== b.hiddenSinceMs) {
    return b.hiddenSinceMs - a.hiddenSinceMs
  }
  const activationDelta = (b.lastActivatedSeq ?? -1) - (a.lastActivatedSeq ?? -1)
  return activationDelta === 0 ? a.id.localeCompare(b.id) : activationDelta
}

// Why: the single most-recently-hidden candidate is the view the user just
// switched away from; keeping it warm regardless of the TTL or cap means
// switching back after any absence (a meeting, coffee) is always instant, the
// remount cost users actually notice.
function selectLastActiveRetainedId(candidates: ColdParkRetainCandidate[]): string | null {
  let lastActive: ColdParkRetainCandidate | null = null
  for (const candidate of candidates) {
    if (lastActive === null || compareColdParkRecencyDesc(candidate, lastActive) < 0) {
      lastActive = candidate
    }
  }
  return lastActive?.id ?? null
}

// Why: hot-retain keeps the most recently hidden ids warm up to the limit;
// ids hidden past hotRetainMs or beyond the limit cold-park. The last-active
// id is exempt from both so returning to it never pays a remount.
export function selectIdsBeyondHotRetain(
  candidates: ColdParkRetainCandidate[],
  args: { nowMs: number; hotRetainMs: number; hotRetainLimit: number }
): Set<string> {
  const lastActiveId = selectLastActiveRetainedId(candidates)
  const coldParkedIds = new Set<string>()
  const retainedCandidates: ColdParkRetainCandidate[] = []
  for (const candidate of candidates) {
    if (candidate.id === lastActiveId) {
      continue
    }
    if (args.nowMs - candidate.hiddenSinceMs >= args.hotRetainMs) {
      coldParkedIds.add(candidate.id)
    } else {
      retainedCandidates.push(candidate)
    }
  }
  retainedCandidates.sort(compareColdParkRecencyDesc)
  // Why: the last-active id already holds one slot in the warm working set, so
  // the cap counts it out — the remaining candidates fill hotRetainLimit-1.
  const remainingLimit = lastActiveId === null ? args.hotRetainLimit : args.hotRetainLimit - 1
  for (const candidate of retainedCandidates.slice(Math.max(0, remainingLimit))) {
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
    restorePolicy?: TerminalParkRestorePolicy
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
        coldParkDelayMs,
        ...(args.restorePolicy ? { restorePolicy: args.restorePolicy } : {})
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
    parkCooldownUntilMs?: number | null
    restorePolicy?: TerminalParkRestorePolicy
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
        coldParkDelayMs,
        parkCooldownUntilMs: args.parkCooldownUntilMs,
        ...(args.restorePolicy ? { restorePolicy: args.restorePolicy } : {})
      })
    ) {
      continue
    }
    candidates.push({
      id: tab.id,
      hiddenSinceMs: tab.hiddenSinceMs,
      lastActivatedSeq: tab.lastActivatedSeq
    })
  }
  return selectIdsBeyondHotRetain(candidates, {
    nowMs: args.nowMs,
    hotRetainMs: args.hotRetainMs ?? TERMINAL_TAB_HOT_RETAIN_MS,
    hotRetainLimit: args.hotRetainLimit ?? TERMINAL_TAB_HOT_RETAIN_LIMIT
  })
}
