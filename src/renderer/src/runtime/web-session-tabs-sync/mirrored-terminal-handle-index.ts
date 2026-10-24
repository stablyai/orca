import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { sessionTabsFreshnessKey } from './state'
import { isReadyTerminalTab, isTerminalSurfaceTab } from './terminal-surfaces'
import { isWebSessionTabsWorktreeRemovalFrame } from './session-tabs-inventory-absence'

type WorktreeSurfaces = {
  environmentId: string
  worktreeId: string
  /** Local ids of every terminal tab the latest snapshot published, ready or not. */
  tabIds: ReadonlySet<string>
  handlesBySurface: ReadonlyMap<string, string>
}

type HandlesChangedListener = (environmentId: string, worktreeId: string) => void

const surfacesByWorktree = new Map<string, WorktreeSurfaces>()
const listeners = new Set<HandlesChangedListener>()
const pendingNotifications = new Map<string, { environmentId: string; worktreeId: string }>()
let notificationScheduled = false

const NO_TAB_IDS: ReadonlySet<string> = new Set()

function surfaceKey(hostParentTabId: string, leafId: string): string {
  return `${hostParentTabId}\0${leafId}`
}

function sameHandles(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const [key, handle] of a) {
    if (b.get(key) !== handle) {
      return false
    }
  }
  return true
}

// Why a microtask: snapshots are indexed inside the store updater, and listeners read the committed store.
function notifyHandlesChanged(environmentId: string, worktreeId: string): void {
  pendingNotifications.set(sessionTabsFreshnessKey(environmentId, worktreeId), {
    environmentId,
    worktreeId
  })
  if (notificationScheduled) {
    return
  }
  notificationScheduled = true
  queueMicrotask(() => {
    notificationScheduled = false
    const batch = [...pendingNotifications.values()]
    pendingNotifications.clear()
    for (const { environmentId: env, worktreeId: wt } of batch) {
      for (const listener of listeners) {
        try {
          listener(env, wt)
        } catch (error) {
          console.warn('[web-session-tabs-sync] terminal handle listener failed:', error)
        }
      }
    }
  })
}

/** Records one snapshot's terminal surfaces and returns the tab ids the previous one published. */
export function indexMirroredTerminalSurfaces(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): ReadonlySet<string> {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const previous = surfacesByWorktree.get(key)
  if (isWebSessionTabsWorktreeRemovalFrame(snapshot)) {
    forgetWorktree(key, previous)
    return previous?.tabIds ?? NO_TAB_IDS
  }
  const tabIds = new Set<string>()
  const handlesBySurface = new Map<string, string>()
  for (const tab of snapshot.tabs) {
    if (!isTerminalSurfaceTab(tab)) {
      continue
    }
    tabIds.add(toWebTerminalSurfaceTabId(tab.parentTabId))
    if (isReadyTerminalTab(tab)) {
      handlesBySurface.set(surfaceKey(tab.parentTabId, tab.leafId), tab.terminal)
    }
  }
  surfacesByWorktree.set(key, {
    environmentId,
    worktreeId: snapshot.worktree,
    tabIds,
    handlesBySurface
  })
  if (!sameHandles(previous?.handlesBySurface ?? new Map(), handlesBySurface)) {
    notifyHandlesChanged(environmentId, snapshot.worktree)
  }
  return previous?.tabIds ?? NO_TAB_IDS
}

function forgetWorktree(key: string, entry: WorktreeSurfaces | undefined): void {
  if (!entry) {
    return
  }
  surfacesByWorktree.delete(key)
  if (entry.handlesBySurface.size > 0) {
    notifyHandlesChanged(entry.environmentId, entry.worktreeId)
  }
}

/** Drops a worktree's index, or every worktree of the environment when none is named. */
export function forgetMirroredTerminalHandles(environmentId: string, worktreeId?: string): void {
  if (worktreeId !== undefined) {
    const key = sessionTabsFreshnessKey(environmentId, worktreeId)
    forgetWorktree(key, surfacesByWorktree.get(key))
    return
  }
  for (const [key, entry] of surfacesByWorktree) {
    if (entry.environmentId === environmentId) {
      forgetWorktree(key, entry)
    }
  }
}

/** The ready handle of a host terminal surface, from the latest session.tabs snapshot; null when none. */
export function mirroredTerminalHandle(
  environmentId: string,
  worktreeId: string,
  hostParentTabId: string,
  leafId: string
): string | null {
  return (
    surfacesByWorktree
      .get(sessionTabsFreshnessKey(environmentId, worktreeId))
      ?.handlesBySurface.get(surfaceKey(hostParentTabId, leafId)) ?? null
  )
}

/** Fires after a snapshot changed any handle in the index for that worktree. */
export function onMirroredTerminalHandlesChanged(listener: HandlesChangedListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetMirroredTerminalHandlesForTests(): void {
  surfacesByWorktree.clear()
  listeners.clear()
  pendingNotifications.clear()
}
