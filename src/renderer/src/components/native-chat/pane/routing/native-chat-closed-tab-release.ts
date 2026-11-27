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

// Workspaces whose chat layer mounted: only they can own released state, so only they are compared.
const watchedWorktrees = new Set<string>()
let unsubscribe: (() => void) | null = null

/**
 * Why the store, not the layers: a tab can close while its workspace's layer is unmounted. Each tab-list write
 * compares only watched workspaces, so a title tick costs O(workspaces visited), not O(all workspaces). Tabs never
 * move between workspaces, so a tab gone from its workspace's list is closed.
 */
export function watchClosedChatTabs(worktreeId: string): void {
  watchedWorktrees.add(worktreeId)
  unsubscribe ??= useAppStore.subscribe((state, previous) => {
    const next = state.unifiedTabsByWorktree
    const before = previous.unifiedTabsByWorktree
    if (next === before) {
      return
    }
    const closed = new Set<string>()
    for (const id of watchedWorktrees) {
      const was = before[id]
      const now = next[id]
      if (was === now || !was) {
        continue
      }
      const live = new Set(now?.map((tab) => tab.id))
      for (const tab of was) {
        if (!live.has(tab.id)) {
          closed.add(tab.id)
        }
      }
      if (!now) {
        watchedWorktrees.delete(id)
      }
    }
    if (closed.size > 0) {
      releaseClosedChatTabs(closed)
    }
  })
}
