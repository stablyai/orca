import { PTY_SESSION_ID_SEPARATOR } from '../../../../shared/pty-session-id-format'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { TerminalTab } from '../../../../shared/types'
import { isRemoteRuntimePtyId } from '../../runtime/runtime-terminal-inspection'

export const TERMINAL_WORKTREE_COLD_PARK_DELAY_MS = 30_000
export const TERMINAL_WORKTREE_HOT_RETAIN_MS = 5 * 60_000
export const TERMINAL_WORKTREE_HOT_RETAIN_LIMIT = 4
export const TERMINAL_WORKTREE_PARK_DELAY_MS = TERMINAL_WORKTREE_COLD_PARK_DELAY_MS
export const TERMINAL_TAB_COLD_PARK_DELAY_MS = 30_000
export const TERMINAL_TAB_HOT_RETAIN_MS = 5 * 60_000
export const TERMINAL_TAB_HOT_RETAIN_LIMIT = 12

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

export function isSnapshotBackedTerminalPty(ptyId: string | null, worktreeId: string): boolean {
  if (!ptyId) {
    return false
  }
  if (isRemoteRuntimePtyId(ptyId) || parseAppSshPtyId(ptyId)) {
    return false
  }
  const separatorIdx = ptyId.lastIndexOf(PTY_SESSION_ID_SEPARATOR)
  return separatorIdx === -1 || ptyId.slice(0, separatorIdx) === worktreeId
}

export function canParkTerminalWorktreeRenderers(args: {
  worktreeId: string
  terminalTabs: readonly ColdParkableTerminalTab[]
  pendingStartupByTabId: Readonly<Record<string, unknown>>
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  hasActivityTerminalPortal: boolean
  hiddenSinceMs: number | null
  nowMs: number
  coldParkDelayMs?: number
}): boolean {
  if (
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
  nowMs: number
  coldParkDelayMs?: number
}): boolean {
  const tab = args.terminalTab
  if (tab.isVisible || tab.hasActivityTerminalPortal || tab.hiddenSinceMs === null) {
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

export function selectColdParkedTerminalWorktrees(args: {
  worktrees: readonly TerminalWorktreeColdParkCandidate[]
  pendingStartupByTabId: Readonly<Record<string, unknown>>
  nowMs: number
  coldParkDelayMs?: number
  hotRetainMs?: number
  hotRetainLimit?: number
}): Set<string> {
  const coldParkDelayMs = args.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS
  const hotRetainMs = args.hotRetainMs ?? TERMINAL_WORKTREE_HOT_RETAIN_MS
  const hotRetainLimit = Math.max(0, args.hotRetainLimit ?? TERMINAL_WORKTREE_HOT_RETAIN_LIMIT)
  const coldParkedWorktreeIds = new Set<string>()
  const retainedCandidates: { worktreeId: string; hiddenSinceMs: number }[] = []

  for (const worktree of args.worktrees) {
    if (
      !canParkTerminalWorktreeRenderers({
        ...worktree,
        pendingStartupByTabId: args.pendingStartupByTabId,
        nowMs: args.nowMs,
        coldParkDelayMs
      })
    ) {
      continue
    }
    const hiddenSinceMs = worktree.hiddenSinceMs
    if (hiddenSinceMs === null) {
      continue
    }
    if (args.nowMs - hiddenSinceMs >= hotRetainMs) {
      coldParkedWorktreeIds.add(worktree.worktreeId)
      continue
    }
    retainedCandidates.push({
      worktreeId: worktree.worktreeId,
      hiddenSinceMs
    })
  }

  retainedCandidates.sort((a, b) => {
    const recencyDelta = b.hiddenSinceMs - a.hiddenSinceMs
    return recencyDelta === 0 ? a.worktreeId.localeCompare(b.worktreeId) : recencyDelta
  })

  for (const candidate of retainedCandidates.slice(hotRetainLimit)) {
    coldParkedWorktreeIds.add(candidate.worktreeId)
  }

  return coldParkedWorktreeIds
}

export function selectColdParkedTerminalTabs(args: {
  worktreeId: string
  terminalTabs: readonly TerminalTabColdParkCandidate[]
  pendingStartupByTabId: Readonly<Record<string, unknown>>
  nowMs: number
  coldParkDelayMs?: number
  hotRetainMs?: number
  hotRetainLimit?: number
}): Set<string> {
  const coldParkDelayMs = args.coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS
  const hotRetainMs = args.hotRetainMs ?? TERMINAL_TAB_HOT_RETAIN_MS
  const hotRetainLimit = Math.max(0, args.hotRetainLimit ?? TERMINAL_TAB_HOT_RETAIN_LIMIT)
  const coldParkedTabIds = new Set<string>()
  const retainedCandidates: { tabId: string; hiddenSinceMs: number }[] = []

  for (const tab of args.terminalTabs) {
    if (
      !canParkTerminalTabRenderer({
        worktreeId: args.worktreeId,
        terminalTab: tab,
        pendingStartupByTabId: args.pendingStartupByTabId,
        nowMs: args.nowMs,
        coldParkDelayMs
      })
    ) {
      continue
    }
    const hiddenSinceMs = tab.hiddenSinceMs
    if (hiddenSinceMs === null) {
      continue
    }
    if (args.nowMs - hiddenSinceMs >= hotRetainMs) {
      coldParkedTabIds.add(tab.id)
      continue
    }
    retainedCandidates.push({
      tabId: tab.id,
      hiddenSinceMs
    })
  }

  retainedCandidates.sort((a, b) => {
    const recencyDelta = b.hiddenSinceMs - a.hiddenSinceMs
    return recencyDelta === 0 ? a.tabId.localeCompare(b.tabId) : recencyDelta
  })

  for (const candidate of retainedCandidates.slice(hotRetainLimit)) {
    coldParkedTabIds.add(candidate.tabId)
  }

  return coldParkedTabIds
}

export function getTerminalWorktreeColdParkRecheckDelayMs(args: {
  hiddenSinceMs: number | null
  nowMs: number
  coldParkDelayMs?: number
  hotRetainMs?: number
}): number | null {
  if (args.hiddenSinceMs === null) {
    return null
  }
  const coldParkDelayMs = args.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS
  const hotRetainMs = args.hotRetainMs ?? TERMINAL_WORKTREE_HOT_RETAIN_MS
  const nextRecheckAtMs = [args.hiddenSinceMs + coldParkDelayMs, args.hiddenSinceMs + hotRetainMs]
    .filter((deadlineMs) => deadlineMs > args.nowMs)
    .sort((a, b) => a - b)[0]
  return nextRecheckAtMs === undefined ? null : nextRecheckAtMs - args.nowMs
}

export function getTerminalTabColdParkRecheckDelayMs(args: {
  hiddenSinceMs: number | null
  nowMs: number
  coldParkDelayMs?: number
  hotRetainMs?: number
}): number | null {
  if (args.hiddenSinceMs === null) {
    return null
  }
  const coldParkDelayMs = args.coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS
  const hotRetainMs = args.hotRetainMs ?? TERMINAL_TAB_HOT_RETAIN_MS
  const nextRecheckAtMs = [args.hiddenSinceMs + coldParkDelayMs, args.hiddenSinceMs + hotRetainMs]
    .filter((deadlineMs) => deadlineMs > args.nowMs)
    .sort((a, b) => a - b)[0]
  return nextRecheckAtMs === undefined ? null : nextRecheckAtMs - args.nowMs
}
