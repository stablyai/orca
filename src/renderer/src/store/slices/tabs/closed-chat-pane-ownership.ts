import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AppState } from '../../types'
import {
  chatPaneAddressTabId,
  chatPaneKey
} from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  chatTabsShowingConversation,
  structuredTabsShowingConversation
} from '@/components/native-chat/session/status/structured-agent-session-tabs'

/** A closed chat tab's pane markers sit under its conversation address, which another open tab
 *  showing the same conversation still owns. */
export function closedChatPaneTabIds(
  state: Pick<AppState, 'unifiedTabsByWorktree'>,
  closed: Pick<Tab, 'id' | 'entityId'>
): string[] {
  const showing = structuredTabsShowingConversation(
    state.unifiedTabsByWorktree,
    chatPaneKey(closed.entityId)
  )
  for (const tab of showing) {
    if (tab.id !== closed.id) {
      return []
    }
  }
  return [chatPaneAddressTabId(closed.entityId)]
}

export function anotherChatTabInWorktree(
  state: Pick<AppState, 'unifiedTabsByWorktree'>,
  closed: Tab,
  worktreeId: string,
  matches?: (tab: Tab) => boolean
): boolean {
  const showing = chatTabsShowingConversation(
    state.unifiedTabsByWorktree,
    chatPaneKey(closed.entityId)
  )
  for (const tab of showing) {
    if (tab.id !== closed.id && tab.worktreeId === worktreeId && (!matches || matches(tab))) {
      return true
    }
  }
  return false
}
