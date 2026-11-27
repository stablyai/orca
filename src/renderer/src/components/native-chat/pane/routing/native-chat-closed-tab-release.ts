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

export function trackChatTabs(worktreeId: string, tabIds: Iterable<string>): void {
  for (const tabId of tabIds) {
    trackedTabs.set(tabId, worktreeId)
  }
}

/**
 * Releases tracked tabs gone from the tab store, including ones closed while their workspace's layer was unmounted.
 * Why layers call it as they mount, unmount or change tabs, not on store writes: title and status writes are frequent
 * and touch tab lists; a sweep costs O(tracked tabs) per user-driven layer change and nothing per write.
 */
export function sweepClosedChatTabs(): void {
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
