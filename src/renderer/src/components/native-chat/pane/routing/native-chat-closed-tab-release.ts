import { useAppStore } from '@/store'
import { releaseNativeChatComposerEditors } from '../../composer/editor/native-chat-composer-editor-owner'
import { releaseNativeChatViewTabs } from '../ownership/native-chat-view-memory'
import { chatViewRetention } from './native-chat-view-retention'
import { forgetNativeChatAsyncSkipsForTabs } from '../../prompts/use-native-chat-async-questions'

/** A closed chat tab's place, kept editor, view state and kept skips end with it. */
export function releaseClosedChatTabs(closed: ReadonlySet<string>): void {
  chatViewRetention.forget(closed)
  releaseNativeChatComposerEditors(closed)
  releaseNativeChatViewTabs(closed)
  forgetNativeChatAsyncSkipsForTabs(closed)
}

// Chat tabs a layer has owned, by workspace: only they can hold released state.
const trackedByWorktree = new Map<string, Set<string>>()
const tabsByLayer = new Map<string, ReadonlySet<string>>()
const layerWorktrees = new Map<string, string>()

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
  layerWorktrees.set(layerId, worktreeId)
  const gone = [...previous].filter((id) => !tabIds.has(id))
  for (const tabId of tabIds) {
    tracked.add(tabId)
  }
  releaseGone(worktreeId, tracked, gone, {
    byWorktree: useAppStore.getState().unifiedTabsByWorktree
  })
}

/** Other workspaces swept per unmount: tabs closed (or a workspace removed) where no layer shows are found in turn. */
const SWEPT_ELSEWHERE_PER_UNMOUNT = 8

/** A layer unmounted (its workspace parked, emptied or removed): its workspace's closed tabs are released. */
export function forgetChatLayer(layerId: string, worktreeId: string): void {
  tabsByLayer.delete(layerId)
  layerWorktrees.delete(layerId)
  const pass: ReleasePass = { byWorktree: useAppStore.getState().unifiedTabsByWorktree }
  sweepWorktree(worktreeId, pass)
  // Workspaces no layer shows get no report or unmount; a few are checked per unmount, oldest-checked first.
  const shown = new Set(layerWorktrees.values())
  const due: string[] = []
  for (const other of trackedByWorktree.keys()) {
    if (due.length === SWEPT_ELSEWHERE_PER_UNMOUNT) {
      break
    }
    if (other !== worktreeId && !shown.has(other)) {
      due.push(other)
    }
  }
  due.forEach((other) => sweepWorktree(other, pass))
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
    return
  }
  // Re-inserted, so the next sweeps start with workspaces checked longest ago.
  trackedByWorktree.delete(worktreeId)
  trackedByWorktree.set(worktreeId, tracked)
  const live = new Set(pass.byWorktree[worktreeId]?.map((tab) => tab.id))
  releaseGone(
    worktreeId,
    tracked,
    [...tracked].filter((id) => !live.has(id)),
    pass
  )
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
    }
  }
  if (tracked.size === 0) {
    trackedByWorktree.delete(worktreeId)
  }
  if (closed.size > 0) {
    releaseClosedChatTabs(closed)
  }
}
