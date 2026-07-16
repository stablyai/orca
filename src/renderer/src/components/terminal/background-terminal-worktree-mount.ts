import {
  BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
  type BackgroundMountTerminalWorktreeDetail
} from '@/constants/terminal'

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

/**
 * Records the request before emitting the compatibility event. Why: Terminal
 * is lazy and absent on the landing screen, so a window-only event can fire
 * before its listener exists and permanently lose a navigation-free wake.
 */
export function requestBackgroundTerminalWorktreeMount(
  detail: BackgroundMountTerminalWorktreeDetail
): void {
  if (!detail.worktreeId) {
    return
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

/**
 * Records which terminal tabs a background mount may instantiate. Why: a
 * whole-worktree background mount creates a TerminalPane (xterm + PTY connect)
 * for every saved tab, so wake/resume flows pass the exact tabs they need.
 * Must run before the worktree is added to `mountedWorktreeIds`.
 */
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
  // Why: a worktree mounted without a restriction is fully mounted (the user
  // visited it, or a legacy whole-worktree mount ran); narrowing it
  // retroactively would unmount live panes.
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

// Why deferral exists: activating a worktree used to mount a TerminalPane for
// every saved tab in one render pass. Each mount replays scrollback through
// xterm, attaches a WebGL renderer, and issues a sync-IPC snapshot read, so a
// worktree with many agent-session tabs froze the renderer for tens of
// seconds (field trace: 200+ replay-guard stall releases in one activation
// window). Deferred tabs behave like cold-parked tabs from birth: no view
// until first reveal, parked byte watchers own their side effects meanwhile.
export const COLD_ACTIVATION_TAB_DEFER_THRESHOLD = 4

export function canDeferColdActivationTabsForHost(args: {
  executionHostId: string | null
}): boolean {
  // Why: restored identities can be transient or stale while remote ownership
  // hydrates. Only positively confirmed local execution has daemon snapshots.
  return args.executionHostId === 'local'
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

/**
 * Decides whether activating `worktreeId` should defer mounting its hidden
 * terminal tabs until each is first revealed. Installs the restriction (tabs
 * that mount now) and returns true when deferring; otherwise removes any
 * restriction so the worktree mounts all tabs, the pre-deferral behavior.
 */
export function planColdActivationTabDeferral(opts: {
  restrictions: Map<string, ReadonlySet<string>>
  deferredMountTabIdsByWorktree: Map<string, ReadonlySet<string>>
  worktreeId: string
  allTabIds: readonly string[]
  isTabLive: (tabId: string) => boolean
  /** Safe to leave unmounted: parked byte watchers can cover it and no spawn
   *  is pending. Non-deferrable tabs mount immediately. */
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
    // Why live/previously-allowed tabs stay in: narrowing would unmount
    // panes that are already up (or background mounts still registering).
    if (
      isTabLive(tabId) ||
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

/**
 * Render-pass reveal: tabs the user can currently see (active tab, split
 * groups' active tabs, activity-portal tabs, pending spawns) mount this pass.
 * Once every tab has been revealed the restriction is removed, returning the
 * worktree to normal fully-mounted semantics.
 */
export function revealActivationDeferredTabs(opts: {
  restrictions: Map<string, ReadonlySet<string>>
  deferredMountTabIdsByWorktree: Map<string, ReadonlySet<string>>
  worktreeId: string
  allTabIds: readonly string[]
  immediateTabIds: ReadonlySet<string>
}): void {
  const { restrictions, deferredMountTabIdsByWorktree, worktreeId, allTabIds, immediateTabIds } =
    opts
  // Why: targeted background mounts share the allowed-tab restriction map,
  // but only activation deferral may eagerly fan out parked watcher coverage.
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

/** Tabs a restriction currently keeps unmounted — the set that needs parked
 *  byte-watcher coverage while deferred. */
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

/**
 * Releases closed tabs from targeted and activation restrictions. Whole-worktree
 * and fully user-visited mounts have no restriction entry and are retained.
 */
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
        // Why: once every deferred tab is gone, the remaining live tabs are
        // already allowed; release the now-redundant activation restriction.
        restrictions.delete(worktreeId)
        continue
      }
    }
    if (retained.size === tabIds.size) {
      continue
    }
    changed = true
    if (retained.size === 0) {
      // Why: an activation restriction may legitimately have no allowed tabs
      // while live deferred tabs remain; keep the active surface mounted.
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
