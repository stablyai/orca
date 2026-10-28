import {
  BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
  type BackgroundMountTerminalWorktreeDetail
} from '@/constants/terminal'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { requestSleepingAgentWakeOnMount } from '@/lib/sleeping-agent-wake-requests'

const pendingMounts = new Map<string, BackgroundMountTerminalWorktreeDetail>()
const requestListeners = new Set<() => void>()
let hasRequestedMount = false

function mergePendingMount(detail: BackgroundMountTerminalWorktreeDetail): void {
  const existing = pendingMounts.get(detail.worktreeId)
  if (!existing) {
    pendingMounts.set(detail.worktreeId, {
      worktreeId: detail.worktreeId,
      ...(detail.tabIds !== undefined ? { tabIds: [...new Set(detail.tabIds)] } : {})
    })
    return
  }
  if (existing.tabIds === undefined || detail.tabIds === undefined) {
    pendingMounts.set(detail.worktreeId, { worktreeId: detail.worktreeId })
    return
  }
  pendingMounts.set(detail.worktreeId, {
    worktreeId: detail.worktreeId,
    tabIds: [...new Set([...existing.tabIds, ...detail.tabIds])]
  })
}

// Record before emitting: lazy Terminal may not have a listener yet, otherwise losing navigation-free wakes.
export function requestBackgroundTerminalWorktreeMount(
  detail: BackgroundMountTerminalWorktreeDetail
): void {
  if (!detail.worktreeId) {
    return
  }
  // Only targeted wakes mark sleeping agents; whole-worktree mounts must not authorize every hidden remount.
  if (detail.tabIds) {
    requestSleepingAgentWakeOnMount(detail.worktreeId, detail.tabIds)
  }
  mergePendingMount(detail)
  if (!hasRequestedMount) {
    hasRequestedMount = true
    for (const listener of requestListeners) {
      listener()
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<BackgroundMountTerminalWorktreeDetail>(
        BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
        { detail }
      )
    )
  }
}

export function takePendingBackgroundTerminalWorktreeMount(
  worktreeId: string | undefined
): BackgroundMountTerminalWorktreeDetail | null {
  if (!worktreeId) {
    return null
  }
  const pending = pendingMounts.get(worktreeId) ?? null
  pendingMounts.delete(worktreeId)
  return pending
}

export function takeAllPendingBackgroundTerminalWorktreeMounts(): BackgroundMountTerminalWorktreeDetail[] {
  const pending = [...pendingMounts.values()]
  pendingMounts.clear()
  return pending
}

export function subscribeBackgroundTerminalWorktreeMountRequests(listener: () => void): () => void {
  requestListeners.add(listener)
  return () => requestListeners.delete(listener)
}

export function hasRequestedBackgroundTerminalWorktreeMount(): boolean {
  return hasRequestedMount
}

export function addBackgroundMountedTerminalWorktree(
  mountedWorktreeIds: Set<string>,
  worktreeId: string | undefined,
  onAdded: () => void
): boolean {
  if (!worktreeId || mountedWorktreeIds.has(worktreeId)) {
    return false
  }
  mountedWorktreeIds.add(worktreeId)
  onAdded()
  return true
}

/** Install exact allowed tabs before mounting the worktree; unrestricted background mounts create an xterm/PTY connection for every saved tab. */
export function applyBackgroundMountTabRestriction(
  restrictions: Map<string, ReadonlySet<string>>,
  mountedWorktreeIds: ReadonlySet<string>,
  worktreeId: string | undefined,
  tabIds: readonly string[] | undefined
): void {
  if (!worktreeId) {
    return
  }
  const existing = restrictions.get(worktreeId)
  // Never narrow an unrestricted mount retroactively; it would unmount live panes.
  if (mountedWorktreeIds.has(worktreeId) && !existing) {
    return
  }
  if (!tabIds) {
    restrictions.delete(worktreeId)
    return
  }
  if (existing && tabIds.every((tabId) => existing.has(tabId))) {
    return
  }
  restrictions.set(worktreeId, new Set([...(existing ?? []), ...tabIds]))
}

export function shouldMountBackgroundWorktreeTab(
  restrictedTabIds: ReadonlySet<string> | null,
  tabId: string
): boolean {
  return restrictedTabIds === null || restrictedTabIds.has(tabId)
}

// Defer hidden panes to avoid synchronous scrollback/WebGL/IPC fan-out; parked watchers own side effects until reveal.
// Mount only visible panes on the switch path; idle admission later restores the capped warm set.
export const COLD_ACTIVATION_TAB_DEFER_THRESHOLD = 0

/** Gate PTY-binding panes until provider/SSH/ownership restoration settles, or mount can duplicate shells; hydrated tab/chat/browser/editor surfaces may render earlier. */
export function canAdmitTerminalTabsForStartup(args: {
  workspaceSessionReady: boolean
  hydrationSucceeded: boolean
  startupWorktreeRefreshCompleted: boolean
}): boolean {
  return (
    args.workspaceSessionReady && (args.hydrationSucceeded || args.startupWorktreeRefreshCompleted)
  )
}

export function canDeferColdActivationTabsForHost(args: {
  executionHostId: string | null
  pairedRuntimeParkingEnvironmentIds?: ReadonlySet<string>
}): boolean {
  const host = parseExecutionHostId(args.executionHostId)
  if (host?.kind === 'local') {
    return true
  }
  // Remote snapshot capability must belong to the exact host; stale runtime identities stay eager to preserve output.
  return (
    host?.kind === 'runtime' &&
    args.pairedRuntimeParkingEnvironmentIds?.has(host.environmentId) === true
  )
}

function replaceActivationDeferredMountTabs(
  deferredMountTabIdsByWorktree: Map<string, ReadonlySet<string>>,
  worktreeId: string,
  restrictedTabIds: ReadonlySet<string> | null,
  allTabIds: readonly string[]
): void {
  const next = collectDeferredMountTabIds(restrictedTabIds, allTabIds)
  if (next.size === 0) {
    deferredMountTabIdsByWorktree.delete(worktreeId)
    return
  }
  const current = deferredMountTabIdsByWorktree.get(worktreeId)
  if (current?.size === next.size && Array.from(next).every((tabId) => current.has(tabId))) {
    return
  }
  deferredMountTabIdsByWorktree.set(worktreeId, next)
}

/** Restrict activation to visible/non-deferrable panes; remove the restriction when deferral is unsafe. */
export function planColdActivationTabDeferral(opts: {
  restrictions: Map<string, ReadonlySet<string>>
  deferredMountTabIdsByWorktree: Map<string, ReadonlySet<string>>
  worktreeId: string
  allTabIds: readonly string[]
  /** Worktree is passed so duplicate legacy tab ids fail closed by owner. */
  isTabLive: (tabId: string, worktreeId?: string) => boolean
  isTabDeferrable: (tabId: string) => boolean
  immediateTabIds: ReadonlySet<string>
}): boolean {
  const {
    restrictions,
    deferredMountTabIdsByWorktree,
    worktreeId,
    allTabIds,
    isTabLive,
    isTabDeferrable,
    immediateTabIds
  } = opts
  const previouslyAllowed = restrictions.get(worktreeId)
  const initial = new Set<string>()
  for (const tabId of allTabIds) {
    // Retain live/already-allowed tabs so activation cannot unmount panes or race registering background mounts.
    if (
      isTabLive(tabId, worktreeId) ||
      immediateTabIds.has(tabId) ||
      previouslyAllowed?.has(tabId) ||
      !isTabDeferrable(tabId)
    ) {
      initial.add(tabId)
    }
  }
  const deferredCount = allTabIds.length - initial.size
  if (deferredCount <= COLD_ACTIVATION_TAB_DEFER_THRESHOLD) {
    restrictions.delete(worktreeId)
    deferredMountTabIdsByWorktree.delete(worktreeId)
    return false
  }
  restrictions.set(worktreeId, initial)
  replaceActivationDeferredMountTabs(deferredMountTabIdsByWorktree, worktreeId, initial, allTabIds)
  return true
}

/** Admit visible tabs during render; release the restriction once every deferred tab has been revealed. */
export function revealActivationDeferredTabs(opts: {
  restrictions: Map<string, ReadonlySet<string>>
  deferredMountTabIdsByWorktree: Map<string, ReadonlySet<string>>
  worktreeId: string
  allTabIds: readonly string[]
  immediateTabIds: ReadonlySet<string>
}): void {
  const { restrictions, deferredMountTabIdsByWorktree, worktreeId, allTabIds, immediateTabIds } =
    opts
  // Only activation deferral may expand eager watcher coverage; targeted mounts share restrictions but stay bounded.
  if (!deferredMountTabIdsByWorktree.has(worktreeId)) {
    return
  }
  const existing = restrictions.get(worktreeId)
  if (!existing) {
    deferredMountTabIdsByWorktree.delete(worktreeId)
    return
  }
  let grew = false
  for (const tabId of immediateTabIds) {
    if (!existing.has(tabId)) {
      grew = true
      break
    }
  }
  const next = grew ? new Set([...existing, ...immediateTabIds]) : existing
  if (allTabIds.length > 0 && allTabIds.every((tabId) => next.has(tabId))) {
    restrictions.delete(worktreeId)
    deferredMountTabIdsByWorktree.delete(worktreeId)
    return
  }
  if (grew) {
    restrictions.set(worktreeId, next)
  }
  replaceActivationDeferredMountTabs(deferredMountTabIdsByWorktree, worktreeId, next, allTabIds)
}

/** Unadmitted tabs need parked byte watchers. */
export function collectDeferredMountTabIds(
  restrictedTabIds: ReadonlySet<string> | null,
  tabIds: readonly string[]
): Set<string> {
  const deferred = new Set<string>()
  if (restrictedTabIds === null) {
    return deferred
  }
  for (const tabId of tabIds) {
    if (!restrictedTabIds.has(tabId)) {
      deferred.add(tabId)
    }
  }
  return deferred
}

/** Prune closed tabs without dropping whole-worktree or unrestricted mounts. */
export function pruneClosedBackgroundMountTabs(
  restrictions: Map<string, ReadonlySet<string>>,
  mountedWorktreeIds: Set<string>,
  tabsByWorktree: Record<string, readonly { id: string }[]>,
  deferredMountTabIdsByWorktree?: Map<string, ReadonlySet<string>>
): boolean {
  let changed = false
  for (const [worktreeId, tabIds] of restrictions) {
    const liveTabIds = new Set((tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
    const retained = new Set([...tabIds].filter((tabId) => liveTabIds.has(tabId)))
    const deferred = deferredMountTabIdsByWorktree?.get(worktreeId)
    const retainedDeferred = deferred
      ? new Set([...deferred].filter((tabId) => liveTabIds.has(tabId)))
      : null
    const deferredChanged = deferred !== undefined && retainedDeferred?.size !== deferred.size
    if (deferredChanged) {
      changed = true
      if (retainedDeferred && retainedDeferred.size > 0) {
        deferredMountTabIdsByWorktree?.set(worktreeId, retainedDeferred)
      } else {
        deferredMountTabIdsByWorktree?.delete(worktreeId)
        // No deferred tabs remain, so release the redundant activation restriction.
        restrictions.delete(worktreeId)
        continue
      }
    }
    if (retained.size === tabIds.size) {
      continue
    }
    changed = true
    if (retained.size === 0) {
      // Keep an empty-allowed activation mounted while deferred tabs still exist.
      if (retainedDeferred && retainedDeferred.size > 0) {
        restrictions.set(worktreeId, retained)
      } else {
        restrictions.delete(worktreeId)
        mountedWorktreeIds.delete(worktreeId)
      }
    } else {
      restrictions.set(worktreeId, retained)
    }
  }
  return changed
}
