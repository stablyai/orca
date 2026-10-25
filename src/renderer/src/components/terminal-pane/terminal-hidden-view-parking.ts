import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { isRemoteExecutionHostPtyId } from '../../../../shared/remote-execution-host-pty-id'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { PTY_SESSION_ID_SEPARATOR } from '../../../../shared/pty-session-id-format'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

// Hysteresis avoids quick-switch remounts; bounded hot-retain keeps recent worktrees warm. Reducing remount frequency matters more than replay size.
export const TERMINAL_WORKTREE_COLD_PARK_DELAY_MS = 30_000
export const TERMINAL_WORKTREE_HOT_RETAIN_MS = 5 * 60_000
export const TERMINAL_WORKTREE_HOT_RETAIN_LIMIT = 4
export const TERMINAL_WORKTREE_PARK_DELAY_MS = TERMINAL_WORKTREE_COLD_PARK_DELAY_MS
export const TERMINAL_TAB_COLD_PARK_DELAY_MS = 30_000
export const TERMINAL_TAB_HOT_RETAIN_MS = 5 * 60_000
export const TERMINAL_TAB_HOT_RETAIN_LIMIT = 6

// Pass test overrides explicitly to shorten hysteresis without module-level environment reads.
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
  /** Measure preserves hiddenSince for TTL/rank; cool-down prevents immediate re-park after the lease ends. */
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

// Only this worktree’s local daemon IDs have these snapshots; SSH and paired-runtime eligibility use isParkRestorableTerminalPty.
export function isSnapshotBackedTerminalPty(ptyId: string | null, worktreeId: string): boolean {
  if (!ptyId) {
    return false
  }
  if (isRemoteExecutionHostPtyId(ptyId)) {
    return false
  }
  // Daemon-fail-open IDs lack session models; remount would respawn instead of restoring the shell.
  const separatorIdx = ptyId.lastIndexOf(PTY_SESSION_ID_SEPARATOR)
  return separatorIdx !== -1 && ptyId.slice(0, separatorIdx) === worktreeId
}

export type TerminalParkRestorePolicy = {
  /** settings.terminalSshViewParking !== false — the C1 SSH-parking kill switch. */
  sshParkingEnabled?: boolean
  /** Exact paired environments whose host advertises bounded snapshot restore. */
  pairedRuntimeParkingEnvironmentIds?: ReadonlySet<string>
}

export {
  resetPairedRuntimeParkingEnvironmentIdsCacheForTest,
  selectPairedRuntimeParkingEnvironmentIds,
  selectPairedRuntimeParkingEnvironmentIdsFromState
} from './paired-runtime-parking-capabilities'

// SSH uses local main’s model; paired PTYs require their exact host’s bounded-restore capability.
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
  // The explicit terminalHiddenViewParking kill switch disables all parking.
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

// View switches stamp tabs together; activation order breaks ties before UUID order.
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

// Keep the last-hidden view warm beyond cap/TTL so switching back remains instant.
function selectLastActiveRetainedId(candidates: ColdParkRetainCandidate[]): string | null {
  let lastActive: ColdParkRetainCandidate | null = null
  for (const candidate of candidates) {
    if (lastActive === null || compareColdParkRecencyDesc(candidate, lastActive) < 0) {
      lastActive = candidate
    }
  }
  return lastActive?.id ?? null
}

// Park past-TTL or over-cap candidates; last-active stays exempt from both.
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
  // Last-active already uses one warm slot; remaining candidates get hotRetainLimit − 1.
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
