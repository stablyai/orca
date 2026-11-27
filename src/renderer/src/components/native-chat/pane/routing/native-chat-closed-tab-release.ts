import { useAppStore } from '@/store'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
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

let watching = false

/**
 * Why the store, not the layers: a tab can close while its workspace's layer is unmounted. Only workspaces whose
 * tab list changed are compared, and a tab moved to another workspace is not closed.
 */
export function watchClosedChatTabs(): void {
  if (watching) {
    return
  }
  watching = true
  useAppStore.subscribe((state, previous) => {
    const next = state.unifiedTabsByWorktree
    const before = previous.unifiedTabsByWorktree
    if (next === before) {
      return
    }
    const removed = new Set<string>()
    const kept = new Set<string>()
    const collect = (tabs: readonly Tab[] | undefined, into: Set<string>): void =>
      tabs?.forEach((tab) => into.add(tab.id))
    for (const worktreeId of new Set([...Object.keys(before), ...Object.keys(next)])) {
      if (before[worktreeId] !== next[worktreeId]) {
        collect(before[worktreeId], removed)
        collect(next[worktreeId], kept)
      }
    }
    const closed = new Set([...removed].filter((id) => !kept.has(id)))
    if (closed.size > 0) {
      releaseClosedChatTabs(closed)
    }
  })
}
