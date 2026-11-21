import type { AppState } from '../../types'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForTab
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { findStructuredAgentSessionReadOwner } from '@/components/native-chat/session/structured/read/structured-agent-session-read-owner-registry'
import {
  closedWorkspaceChat,
  workspaceChatHasConversation
} from '@/lib/agent-session/history/closed-workspace-chat'
import { workspaceChatCatalog } from '@/lib/agent-session/history/workspace-chats'

export function retainClosedWorkspaceChat(
  state: AppState,
  tab: Tab,
  provisional: boolean
): boolean {
  const owner = structuredAgentSessionOwnerForTab(state, tab)
  const target = structuredAgentSessionTargetForTab(state, tab)
  const snapshot = findStructuredAgentSessionReadOwner(
    tab.entityId,
    target,
    owner ?? ''
  )?.getSnapshot()
  const entry = state.agentStatusByPaneKey.get(structuredAgentSessionPaneKey(tab.id, tab.entityId))
  const hasConversation = workspaceChatHasConversation(
    snapshot?.state,
    Boolean(entry?.prompt?.trim() || entry?.lastAssistantMessage?.trim() || tab.aiVaultTitle),
    snapshot?.current
  )
  const chat = closedWorkspaceChat(tab, owner, provisional, hasConversation)
  if (!chat) {
    if (hasConversation === false && owner && !provisional) {
      workspaceChatCatalog().archive({
        workspaceId: tab.worktreeId,
        executionHostId: owner,
        sessionId: tab.entityId
      })
    }
    return false
  }
  workspaceChatCatalog().remember(chat)
  return true
}
