// Record window-picked chat panes in main so saves cannot change them; frames bypass setTabLayout, so its chat moves are window choices.

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
