import { useAppStore } from '@/store'
import { releaseNativeChatViewTabs } from '../ownership/native-chat-view-memory'
import { chatViewRetention } from './native-chat-view-retention'
import { forgetNativeChatAsyncSkipsForTabs } from '../../prompts/use-native-chat-async-questions'
import { setRemovedChatTabsReleaser } from '../../session/native-chat-removed-tab-releaser'

/** A closed chat tab's place, view state and kept skips end with it. */
export function releaseClosedChatTabs(closed: ReadonlySet<string>): void {
  chatViewRetention.forget(closed)
  releaseNativeChatViewTabs(closed)
  forgetNativeChatAsyncSkipsForTabs(closed)
}

// Chat tabs a layer has owned, by workspace: only they can hold released state.
const trackedByWorktree = new Map<string, Set<string>>()
const tabsByLayer = new Map<string, ReadonlySet<string>>()
const layerWorktrees = new Map<string, string>()
const layerCountByWorktree = new Map<string, number>()
// Tracked workspaces no layer shows, oldest-checked first: an unmount sweeps a few without walking the rest.
const unshown = new Set<string>()

/**
 * A layer's tabs changed: only the tabs it lost are released. Its first report also releases this workspace's tabs
 * that closed while no layer showed it.
 */
export function reportChatLayerTabs(
  layerId: string,
  worktreeId: string,
  tabIds: ReadonlySet<string>
): void {
  const tracked = trackedByWorktree.get(worktreeId) ?? new Set<string>()
  trackedByWorktree.set(worktreeId, tracked)
  const previous = tabsByLayer.get(layerId) ?? tracked
  tabsByLayer.set(layerId, tabIds)
  const shownBefore = layerWorktrees.get(layerId)
  if (shownBefore !== worktreeId) {
    if (shownBefore !== undefined) {
      leaveWorktree(shownBefore)
    }
    layerWorktrees.set(layerId, worktreeId)
    layerCountByWorktree.set(worktreeId, (layerCountByWorktree.get(worktreeId) ?? 0) + 1)
    unshown.delete(worktreeId)
  }
  const gone = [...previous].filter((id) => !tabIds.has(id))
  for (const tabId of tabIds) {
    tracked.add(tabId)
  }
  releaseGone(worktreeId, tracked, gone, {
    byWorktree: useAppStore.getState().unifiedTabsByWorktree
  })
  retireIfEmpty(worktreeId, tracked)
}

/** A workspace with no chat tabs left to watch leaves the registry, so empty ones never pile up. */
function retireIfEmpty(worktreeId: string, tracked: Set<string>): void {
  if (tracked.size === 0 && trackedByWorktree.get(worktreeId) === tracked) {
    trackedByWorktree.delete(worktreeId)
    unshown.delete(worktreeId)
  }
}

function leaveWorktree(worktreeId: string): void {
  const count = (layerCountByWorktree.get(worktreeId) ?? 1) - 1
  if (count > 0) {
    layerCountByWorktree.set(worktreeId, count)
    return
  }
  layerCountByWorktree.delete(worktreeId)
  if (trackedByWorktree.has(worktreeId)) {
    unshown.add(worktreeId)
  }
}

/** Other workspaces swept per unmount: a workspace removed while no layer showed it is found in turn. */
const SWEPT_ELSEWHERE_PER_UNMOUNT = 8

/** A layer unmounted (its workspace parked, emptied or removed): its workspace's closed tabs are released. */
export function forgetChatLayer(layerId: string, worktreeId: string): void {
  tabsByLayer.delete(layerId)
  const shown = layerWorktrees.get(layerId)
  layerWorktrees.delete(layerId)
  if (shown !== undefined) {
    leaveWorktree(shown)
  }
  const pass: ReleasePass = { byWorktree: useAppStore.getState().unifiedTabsByWorktree }
  sweepWorktree(worktreeId, pass)
  const due: string[] = []
  for (const other of unshown) {
    if (due.length === SWEPT_ELSEWHERE_PER_UNMOUNT) {
      break
    }
    if (other !== worktreeId) {
      due.push(other)
    }
  }
  due.forEach((other) => sweepWorktree(other, pass))
}

/**
 * Tabs the tab store removed (a close, a bulk close, a host's snapshot): released once that change commits, unless
 * the tab still lives in some workspace, as a moved tab does.
 */
const removedPending = new Map<string, string>()
export function releaseRemovedChatTabs(
  removed: readonly { id: string; worktreeId: string }[]
): void {
  if (removed.length === 0) {
    return
  }
  const first = removedPending.size === 0
  removed.forEach((tab) => removedPending.set(tab.id, tab.worktreeId))
  if (first) {
    // The callers run inside the store update; the release reads the store after it commits.
    queueMicrotask(() => {
      const pass: ReleasePass = { byWorktree: useAppStore.getState().unifiedTabsByWorktree }
      const byWorktree = new Map<string, string[]>()
      for (const [tabId, worktreeId] of removedPending) {
        const gone = byWorktree.get(worktreeId)
        if (gone) {
          gone.push(tabId)
        } else {
          byWorktree.set(worktreeId, [tabId])
        }
      }
      removedPending.clear()
      for (const [worktreeId, gone] of byWorktree) {
        const tracked = trackedByWorktree.get(worktreeId) ?? new Set(gone)
        releaseGone(worktreeId, tracked, gone, pass)
      }
    })
  }
}

type TabsByWorktree = ReturnType<typeof useAppStore.getState>['unifiedTabsByWorktree']
type ReleasePass = { byWorktree: TabsByWorktree; owners?: Map<string, string> }

/** Each open tab's workspace, built at most once per pass and only when some tab may be released. */
function liveOwners(pass: ReleasePass): Map<string, string> {
  if (!pass.owners) {
    pass.owners = new Map()
    for (const [worktreeId, tabs] of Object.entries(pass.byWorktree)) {
      for (const tab of tabs) {
        pass.owners.set(tab.id, worktreeId)
      }
    }
  }
  return pass.owners
}

function sweepWorktree(worktreeId: string, pass: ReleasePass): void {
  const tracked = trackedByWorktree.get(worktreeId)
  if (!tracked) {
    unshown.delete(worktreeId)
    return
  }
  // Re-inserted, so the next sweeps start with workspaces checked longest ago.
  if (unshown.delete(worktreeId)) {
    unshown.add(worktreeId)
  }
  const live = new Set(pass.byWorktree[worktreeId]?.map((tab) => tab.id))
  releaseGone(
    worktreeId,
    tracked,
    [...tracked].filter((id) => !live.has(id)),
    pass
  )
  retireIfEmpty(worktreeId, tracked)
}

/** Only tabs open in no workspace are released; a tab moved by a rename or drag is tracked where it now lives. */
function releaseGone(
  worktreeId: string,
  tracked: Set<string>,
  gone: readonly string[],
  pass: ReleasePass
): void {
  if (gone.length === 0) {
    return
  }
  const owners = liveOwners(pass)
  const closed = new Set<string>()
  for (const tabId of gone) {
    const owner = owners.get(tabId)
    if (owner === worktreeId) {
      continue
    }
    tracked.delete(tabId)
    if (owner === undefined) {
      closed.add(tabId)
    } else {
      const there = trackedByWorktree.get(owner) ?? new Set<string>()
      trackedByWorktree.set(owner, there.add(tabId))
      if (!layerCountByWorktree.has(owner)) {
        unshown.add(owner)
      }
    }
  }
  retireIfEmpty(worktreeId, tracked)
  if (closed.size > 0) {
    releaseClosedChatTabs(closed)
  }
}

setRemovedChatTabsReleaser(releaseRemovedChatTabs)
