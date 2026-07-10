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

/**
 * Releases targeted mounts after their owning tabs close. Whole-worktree and
 * user-visited mounts have no restriction entry and are intentionally retained.
 */
export function pruneClosedBackgroundMountTabs(
  restrictions: Map<string, ReadonlySet<string>>,
  mountedWorktreeIds: Set<string>,
  tabsByWorktree: Record<string, readonly { id: string }[]>
): boolean {
  let changed = false
  for (const [worktreeId, tabIds] of restrictions) {
    const liveTabIds = new Set((tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
    const retained = new Set([...tabIds].filter((tabId) => liveTabIds.has(tabId)))
    if (retained.size === tabIds.size) {
      continue
    }
    changed = true
    if (retained.size === 0) {
      restrictions.delete(worktreeId)
      mountedWorktreeIds.delete(worktreeId)
    } else {
      restrictions.set(worktreeId, retained)
    }
  }
  return changed
}
