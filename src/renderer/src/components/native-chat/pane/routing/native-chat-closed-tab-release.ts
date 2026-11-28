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

/**
 * A layer's tabs changed: only the tabs it lost are released. Its first report also releases this workspace's tabs
 * that closed while no layer showed it. Never walks other workspaces.
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
  const gone = [...previous].filter((id) => !tabIds.has(id))
  for (const tabId of tabIds) {
    tracked.add(tabId)
  }
  releaseGone(worktreeId, tracked, gone)
}

/** A layer unmounted (its workspace parked, emptied or removed): its workspace's closed tabs are released. */
export function forgetChatLayer(layerId: string, worktreeId: string): void {
  tabsByLayer.delete(layerId)
  const tracked = trackedByWorktree.get(worktreeId)
  if (!tracked) {
    return
  }
  const live = new Set(useAppStore.getState().unifiedTabsByWorktree[worktreeId]?.map((tab) => tab.id))
  releaseGone(worktreeId, tracked, [...tracked].filter((id) => !live.has(id)))
}

function releaseGone(worktreeId: string, tracked: Set<string>, gone: readonly string[]): void {
  if (gone.length === 0) {
    return
  }
  gone.forEach((tabId) => tracked.delete(tabId))
  if (tracked.size === 0) {
    trackedByWorktree.delete(worktreeId)
  }
  releaseClosedChatTabs(new Set(gone))
}
