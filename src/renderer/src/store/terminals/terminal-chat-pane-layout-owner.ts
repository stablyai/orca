// A layout-owner build's record of the chat pane the window picked for a tab: main keeps the same
// pane, so the window's save changes none. Frames write the store directly, so every `setTabLayout`
// that moves the chat pane is the window's own pick.

import { recordLayoutApply } from '@/runtime/layout-apply-send'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { AppState } from '../types'

export function recordChatPaneInLayoutOwner(
  state: AppState,
  tabId: string,
  before: TerminalLayoutSnapshot | undefined,
  after: TerminalLayoutSnapshot | undefined
): void {
  const leafId = after?.chatLeafId ?? null
  // A layout the window first draws for a tab came from main's frame or its saved session.
  if (!before || !after || (before.chatLeafId ?? null) === leafId) {
    return
  }
  const worktreeId = Object.entries(state.tabsByWorktree).find(([, tabs]) =>
    tabs.some((tab) => tab.id === tabId)
  )?.[0]
  if (worktreeId) {
    recordLayoutApply(state, worktreeId, { type: 'setChatPane', tabId, leafId })
  }
}
