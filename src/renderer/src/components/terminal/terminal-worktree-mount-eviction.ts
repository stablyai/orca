// Why this module exists: Terminal kept a mounted terminal surface for every
// worktree the user ever activated (only deletion pruned the set), so xterm
// scrollback (~3-4MB/terminal) accumulated until the renderer heap hit the V8
// ceiling — the top Windows renderer-OOM crash cluster.
import {
  TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
  TERMINAL_WORKTREE_HOT_RETAIN_LIMIT,
  isSnapshotBackedTerminalPty,
  type ColdParkableTerminalTab
} from '../terminal-pane/terminal-hidden-view-parking'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'

// Why 8: deliberately the same warm working set the parking layer sized
// (hot-retain limit), so surface eviction and pane parking bound at one
// boundary instead of fighting — keep them coupled when tuning.
export const MAX_BACKGROUND_MOUNTED_TERMINAL_WORKTREES = TERMINAL_WORKTREE_HOT_RETAIN_LIMIT
// Why: reuse the cold-park hysteresis so quick worktree flips never pay an
// eviction remount. When parking is enabled its recheck timer re-renders at
// exactly this deadline; if parking is disabled eviction (this always-on OOM
// safety net) still runs, just on the next incidental render.
export const BACKGROUND_MOUNT_EVICTION_MIN_HIDDEN_MS = TERMINAL_WORKTREE_COLD_PARK_DELAY_MS

type LiveAgentAttributionEntry = {
  state: string
  paneKey: string
  worktreeId?: string
  tabId?: string
}

/** Worktrees/tabs with a live (non-done) agent row; tearing their surface down mid-turn would lose rendering and churn replay. */
export function collectLiveAgentTerminalAttribution(
  agentStatusByPaneKey: Readonly<Record<string, LiveAgentAttributionEntry>>
): { worktreeIds: Set<string>; tabIds: Set<string> } {
  const worktreeIds = new Set<string>()
  const tabIds = new Set<string>()
  for (const entry of Object.values(agentStatusByPaneKey)) {
    if (entry.state === 'done') {
      continue
    }
    if (entry.worktreeId) {
      worktreeIds.add(entry.worktreeId)
    }
    const tabId =
      entry.tabId ??
      parsePaneKey(entry.paneKey)?.tabId ??
      parseLegacyNumericPaneKey(entry.paneKey)?.tabId
    if (tabId) {
      tabIds.add(tabId)
    }
  }
  return { worktreeIds, tabIds }
}

export function isTerminalWorktreeEvictionSafe(args: {
  worktreeId: string
  terminalTabs: readonly ColdParkableTerminalTab[]
  pendingStartupByTabId: Readonly<Record<string, unknown>>
  liveAgentWorktreeIds: ReadonlySet<string>
  liveAgentTabIds: ReadonlySet<string>
}): boolean {
  if (args.liveAgentWorktreeIds.has(args.worktreeId)) {
    return false
  }
  return args.terminalTabs.every((tab) => {
    if (
      args.liveAgentTabIds.has(tab.id) ||
      args.pendingStartupByTabId[tab.id] !== undefined ||
      tab.pendingActivationSpawn === true ||
      (typeof tab.pendingActivationSpawn === 'number' && tab.pendingActivationSpawn > 0)
    ) {
      return false
    }
    // Why: a null ptyId has no session to lose (remount spawns fresh, exactly
    // like a first activation); a live PTY without a daemon snapshot (remote
    // runtime, SSH, fail-open provider) cannot replay on remount, so keep it.
    return !tab.ptyId || isSnapshotBackedTerminalPty(tab.ptyId, args.worktreeId)
  })
}

/**
 * Bounds the retained hidden terminal surfaces: beyond the cap, the
 * least-recently-hidden eviction-safe worktrees are fully unmounted (set +
 * restriction bookkeeping). PTYs persist in the daemon; re-activation remounts
 * through the ordinary cold-activation path, whose tab deferral caps the cost.
 */
export function evictExcessBackgroundTerminalWorktreeMounts(args: {
  mountedWorktreeIds: Set<string>
  hiddenSinceMsByWorktreeId: Map<string, number>
  backgroundMountTabIdsByWorktree: Map<string, ReadonlySet<string>>
  activationDeferredMountTabIdsByWorktree: Map<string, ReadonlySet<string>>
  activeWorktreeId: string | null
  nowMs: number
  isWorktreeEvictionSafe: (worktreeId: string) => boolean
  maxBackgroundMounts?: number
  minHiddenMs?: number
}): string[] {
  const cap = args.maxBackgroundMounts ?? MAX_BACKGROUND_MOUNTED_TERMINAL_WORKTREES
  const minHiddenMs = args.minHiddenMs ?? BACKGROUND_MOUNT_EVICTION_MIN_HIDDEN_MS
  const activeMounted =
    args.activeWorktreeId !== null && args.mountedWorktreeIds.has(args.activeWorktreeId)
  const overflow = args.mountedWorktreeIds.size - (activeMounted ? 1 : 0) - cap
  if (overflow <= 0) {
    return []
  }
  const candidates: { worktreeId: string; hiddenSinceMs: number }[] = []
  for (const worktreeId of args.mountedWorktreeIds) {
    if (worktreeId === args.activeWorktreeId) {
      continue
    }
    // Why: a targeted background mount (wake/resume, mobile tab subscription,
    // CLI create) must keep its panes until its tabs close or the user visits;
    // activation deferral shares the restriction map but is user-visited state.
    if (
      args.backgroundMountTabIdsByWorktree.has(worktreeId) &&
      !args.activationDeferredMountTabIdsByWorktree.has(worktreeId)
    ) {
      continue
    }
    const hiddenSinceMs = args.hiddenSinceMsByWorktreeId.get(worktreeId)
    // Why: no hidden timestamp means visible/measuring/portal-hosted this pass.
    if (hiddenSinceMs === undefined || args.nowMs - hiddenSinceMs < minHiddenMs) {
      continue
    }
    if (!args.isWorktreeEvictionSafe(worktreeId)) {
      continue
    }
    candidates.push({ worktreeId, hiddenSinceMs })
  }
  candidates.sort((a, b) =>
    a.hiddenSinceMs === b.hiddenSinceMs
      ? a.worktreeId.localeCompare(b.worktreeId)
      : a.hiddenSinceMs - b.hiddenSinceMs
  )
  const evicted = candidates.slice(0, overflow).map((candidate) => candidate.worktreeId)
  for (const worktreeId of evicted) {
    args.mountedWorktreeIds.delete(worktreeId)
    args.backgroundMountTabIdsByWorktree.delete(worktreeId)
    args.activationDeferredMountTabIdsByWorktree.delete(worktreeId)
    args.hiddenSinceMsByWorktreeId.delete(worktreeId)
  }
  return evicted
}
