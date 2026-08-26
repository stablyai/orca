import { isWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import {
  resolveParkedTerminalPaneCandidates,
  type ParkableTerminalTabModel
} from '../terminal-pane/terminal-parked-watcher-reconciliation'
import { WEB_SESSION_TABS_RPC_TIMEOUT_MS } from '../../runtime/web-session-tabs-sync'
import { hasHostSessionMirrorHydrated } from '../../runtime/host-session-mirror-hydration'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import type { useAppStore } from '@/store'

/**
 * Holds restored rows that would spawn a brand-new host shell: activation mounts
 * every persisted row before the host answers `session.tabs`, and a row with no
 * PTY left anywhere takes pty-connection's FRESH SPAWN branch. Watcher coverage
 * cannot defer them — a PTY-less row never satisfies `canWatcherCoverParkedTerminalTab`.
 */

/**
 * Derived from the session.tabs timeout it waits on, so a reply that arrives just
 * under the wire still wins. Bounded only because this gate releases into
 * *mounting*, where failing open is safe; a gate releasing into spawning must not
 * (docs/reference/ssh-execution-boundary.md).
 */
export const RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS = WEB_SESSION_TABS_RPC_TIMEOUT_MS + 5_000

/** Ceiling across reconnects: a flapping runtime must not hold rows indefinitely. */
export const RESTORED_TERMINAL_SPAWN_HOLD_MAX_TOTAL_MS = RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS * 3

export type RestoredSpawnHoldTab = ParkableTerminalTabModel

export type RestoredSpawnHoldPaneState = Pick<
  ReturnType<typeof useAppStore.getState>,
  'terminalLayoutsByTabId' | 'runtimePaneTitlesByTabId' | 'ptyIdsByTabId'
>

export type RestoredSpawnHoldEntry = {
  /** Half the epoch: generations count per environment, so env-2 generation 1 is not env-1's. */
  environmentId: string
  /** Connection the current wait window is scoped to. */
  connectionGeneration: number
  armedAtMs: number
  /** Start of the current window; a new connection earns a fresh one. */
  windowStartedAtMs: number
  /** Host answered: the rows are proven dead, so the hold stops timing out. */
  settled: boolean
  heldTabIds: ReadonlySet<string>
}

/**
 * The host's answer for one workspace, read from the mirror-hydration latch that
 * `web-session-tabs-sync` settles from its landed store patches. Reused rather
 * than re-derived: only that latch knows which frames actually reached the store,
 * and a frame the client dropped is no answer.
 */
export type RestoredSpawnHoldEvidence = {
  connectionGeneration: number
  /** A frame for this worktree, or an inventory covering it, landed on that connection. */
  hostAnswered: boolean
}

export function readRestoredSpawnHoldEvidence(
  environmentId: string,
  worktreeId: string
): RestoredSpawnHoldEvidence {
  return {
    connectionGeneration: getRuntimeEnvironmentConnectionGeneration(environmentId),
    hostAnswered: hasHostSessionMirrorHydrated(environmentId, worktreeId)
  }
}

export type RestoredSpawnHoldPlan = {
  heldTabIds: ReadonlySet<string>
  /** Rows the hold just let go of; callers must re-allow them to mount. */
  releasedTabIds: ReadonlySet<string>
}

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set<string>()

/**
 * Whether mounting this restored row would create a new host shell: `web-terminal-`
 * rows route to the host-session mirror, which has no create path, and a row still
 * owning a PTY anywhere attaches to it instead.
 */
export function willRestoredTabSpawnHostTerminal(
  tab: RestoredSpawnHoldTab,
  state: RestoredSpawnHoldPaneState
): boolean {
  if (isWebTerminalSurfaceTabId(tab.id) || tab.ptyId !== null) {
    return false
  }
  if ((state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0) {
    return false
  }
  return resolveParkedTerminalPaneCandidates(tab, state).every((pane) => pane.ptyId === null)
}

function differenceOf(from: ReadonlySet<string>, remove: ReadonlySet<string>): ReadonlySet<string> {
  const result = new Set<string>()
  for (const id of from) {
    if (!remove.has(id)) {
      result.add(id)
    }
  }
  return result
}

/**
 * Which restored rows stay unmounted while the host's answer for `worktreeId` is
 * outstanding. Holding a visible, group-active, portal, queued, live or
 * already-mounted row would strand an agent resume or unmount a live pane, so those
 * are never held; arming only on the activation pass keeps later user-created tabs out.
 *
 * The answer settles the hold rather than releasing it: an accepted snapshot keeps
 * the dead local row (`shouldReplaceTerminalTab`), so releasing on it would just run
 * the storm one pass later. Held rows stay dark and mount on click.
 */
export function planRestoredTerminalSpawnHold(opts: {
  holdByWorktreeId: Map<string, RestoredSpawnHoldEntry>
  worktreeId: string
  /** Null for local, SSH and folder work, which never wait on a host answer. */
  environmentId: string | null
  evidence: RestoredSpawnHoldEvidence
  /** True only on the activation pass that plans this worktree's mounts. */
  isColdActivationPass: boolean
  nowMs: number
  timeoutMs?: number
  maxTotalMs?: number
  allTabs: readonly RestoredSpawnHoldTab[]
  wouldSpawnHostTerminal: (tab: RestoredSpawnHoldTab) => boolean
  immediateTabIds: ReadonlySet<string>
  isTabLive: (tabId: string) => boolean
  hasMountedTab: (tabId: string) => boolean
}): RestoredSpawnHoldPlan {
  const {
    holdByWorktreeId,
    worktreeId,
    environmentId,
    evidence,
    isColdActivationPass,
    nowMs,
    timeoutMs = RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS,
    maxTotalMs = RESTORED_TERMINAL_SPAWN_HOLD_MAX_TOTAL_MS,
    allTabs,
    wouldSpawnHostTerminal,
    immediateTabIds,
    isTabLive,
    hasMountedTab
  } = opts
  const previous = holdByWorktreeId.get(worktreeId)
  const previousHeld = previous?.heldTabIds ?? EMPTY_TAB_IDS
  const release = (): RestoredSpawnHoldPlan => {
    holdByWorktreeId.delete(worktreeId)
    return { heldTabIds: EMPTY_TAB_IDS, releasedTabIds: previousHeld }
  }
  // Liveness is deliberately not a precondition: on a slow start the probe can still
  // be missing while the workspace mounts, and that cold pass is the storm itself.
  if (!environmentId) {
    return release()
  }
  const isHoldable = (tab: RestoredSpawnHoldTab): boolean =>
    wouldSpawnHostTerminal(tab) &&
    !immediateTabIds.has(tab.id) &&
    !isTabLive(tab.id) &&
    !hasMountedTab(tab.id)
  let entry: RestoredSpawnHoldEntry
  if (!previous) {
    if (!isColdActivationPass) {
      return release()
    }
    const armed = new Set<string>()
    for (const tab of allTabs) {
      if (isHoldable(tab)) {
        armed.add(tab.id)
      }
    }
    entry = {
      environmentId,
      connectionGeneration: evidence.connectionGeneration,
      armedAtMs: nowMs,
      windowStartedAtMs: nowMs,
      settled: false,
      heldTabIds: armed
    }
  } else if (
    previous.environmentId !== environmentId ||
    previous.connectionGeneration !== evidence.connectionGeneration
  ) {
    // A reconnect or host move owes an unsettled hold a fresh window; a mere disconnect
    // advances no generation, so its clock keeps running. armedAtMs stays, so the ceiling holds.
    const movedHost = previous.environmentId !== environmentId
    // A verdict is one host's answer about these rows; the new host has said nothing.
    const settled = movedHost ? false : previous.settled
    entry = {
      ...previous,
      environmentId,
      connectionGeneration: evidence.connectionGeneration,
      settled,
      windowStartedAtMs: settled ? previous.windowStartedAtMs : nowMs
    }
  } else {
    entry = previous
  }
  // Evidence from before the hold armed still counts: those rows are proven dead now.
  const settled = entry.settled || evidence.hostAnswered
  if (
    !settled &&
    (nowMs - entry.windowStartedAtMs >= timeoutMs || nowMs - entry.armedAtMs >= maxTotalMs)
  ) {
    return release()
  }
  const tabById = new Map(allTabs.map((tab) => [tab.id, tab]))
  const next = new Set<string>()
  for (const tabId of entry.heldTabIds) {
    const tab = tabById.get(tabId)
    if (tab && isHoldable(tab)) {
      next.add(tabId)
    }
  }
  if (next.size === 0) {
    return release()
  }
  holdByWorktreeId.set(worktreeId, { ...entry, settled, heldTabIds: next })
  return { heldTabIds: next, releasedTabIds: differenceOf(previousHeld, next) }
}

function haveSameTabIds(current: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  return current.size === next.size && [...next].every((tabId) => current.has(tabId))
}

/** A held row re-runs this every render; a fresh identity for unchanged membership
 *  re-renders the whole memoized surface tree. */
function keepStableTabIds(
  byWorktreeId: Map<string, ReadonlySet<string>>,
  worktreeId: string,
  next: ReadonlySet<string>
): void {
  const current = byWorktreeId.get(worktreeId)
  if (current && haveSameTabIds(current, next)) {
    return
  }
  byWorktreeId.set(worktreeId, next)
}

/**
 * Held rows leave the shared allowed set and join the activation-deferred set,
 * which keeps the worktree surface mounted when no allowed row is left.
 */
export function applyRestoredTerminalSpawnHold(opts: {
  restrictions: Map<string, ReadonlySet<string>>
  deferredMountTabIdsByWorktree: Map<string, ReadonlySet<string>>
  worktreeId: string
  allTabIds: readonly string[]
  plan: RestoredSpawnHoldPlan
}): void {
  const { restrictions, deferredMountTabIdsByWorktree, worktreeId, allTabIds, plan } = opts
  if (plan.heldTabIds.size === 0 && plan.releasedTabIds.size === 0) {
    return
  }
  const allowed = new Set(restrictions.get(worktreeId) ?? allTabIds)
  for (const tabId of plan.releasedTabIds) {
    allowed.add(tabId)
  }
  for (const tabId of plan.heldTabIds) {
    allowed.delete(tabId)
  }
  const deferred = new Set(allTabIds.filter((tabId) => !allowed.has(tabId)))
  if (deferred.size === 0) {
    restrictions.delete(worktreeId)
    deferredMountTabIdsByWorktree.delete(worktreeId)
    return
  }
  keepStableTabIds(restrictions, worktreeId, allowed)
  keepStableTabIds(deferredMountTabIdsByWorktree, worktreeId, deferred)
}
