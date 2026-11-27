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
const trackedTabs = new Map<string, string>()
const tabsByLayer = new Map<string, ReadonlySet<string>>()

/** A layer's tab set changed: only the tabs it lost are released, so one open or close never walks other workspaces. */
export function reportChatLayerTabs(
  layerId: string,
  worktreeId: string,
  tabIds: ReadonlySet<string>
): void {
  const closed = new Set([...(tabsByLayer.get(layerId) ?? [])].filter((id) => !tabIds.has(id)))
  tabsByLayer.set(layerId, tabIds)
  for (const tabId of tabIds) {
    trackedTabs.set(tabId, worktreeId)
  }
  if (closed.size > 0) {
    closed.forEach((tabId) => trackedTabs.delete(tabId))
    releaseClosedChatTabs(closed)
  }
}

/**
 * A layer unmounted (its workspace parked or removed): tabs closed while no layer showed them are found here.
 * Why on unmount, not on store writes: title and status writes are frequent and touch tab lists, while unmounts are
 * rare; the sweep costs O(tracked tabs) per unmount and nothing per write.
 */
export function forgetChatLayer(layerId: string): void {
  tabsByLayer.delete(layerId)
  const byWorktree = useAppStore.getState().unifiedTabsByWorktree
  const live = new Map<string, Set<string>>()
  const closed = new Set<string>()
  for (const [tabId, worktreeId] of trackedTabs) {
    let ids = live.get(worktreeId)
    if (!ids) {
      ids = new Set(byWorktree[worktreeId]?.map((tab) => tab.id))
      live.set(worktreeId, ids)
    }
    if (!ids.has(tabId)) {
      closed.add(tabId)
    }
  }
  if (closed.size > 0) {
    closed.forEach((tabId) => trackedTabs.delete(tabId))
    releaseClosedChatTabs(closed)
  }
}
