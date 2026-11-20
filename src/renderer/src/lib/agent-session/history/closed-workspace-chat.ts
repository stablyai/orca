import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { WorkspaceChat } from './workspace-chats'
import type { StructuredAgentSessionState } from '../../../../../shared/agent-session/view/live-read/structured-agent-session-reducer'

export function workspaceChatHasConversation(
  read:
    | Pick<StructuredAgentSessionState, 'status' | 'items' | 'submissions' | 'hasOlder'>
    | undefined,
  hasSavedEvidence: boolean,
  current = false
): boolean | undefined {
  if (hasSavedEvidence || read?.items.length || read?.submissions.length || read?.hasOlder) {
    return true
  }
  return current && read?.status === 'ready' ? false : undefined
}

export function closedWorkspaceChat(
  tab: Tab,
  owner: ExecutionHostId | null,
  provisional: boolean,
  hasConversation: boolean | undefined
): WorkspaceChat | null {
  if (
    tab.contentType !== 'agent-session' ||
    !owner ||
    provisional ||
    hasConversation === false ||
    !tab.agentSessionAgent
  ) {
    return null
  }
  return {
    workspaceId: tab.worktreeId,
    executionHostId: owner,
    sessionId: tab.entityId,
    agent: tab.agentSessionAgent,
    title:
      tab.customLabel?.trim() || tab.aiVaultTitle?.title || tab.generatedLabel?.trim() || tab.label
  }
}

export function closedWorkspaceChats(
  chats: readonly WorkspaceChat[],
  workspaceId: string,
  executionHostId: ExecutionHostId | null,
  openTabs: readonly Tab[]
): readonly WorkspaceChat[] {
  return chats.filter(
    (chat) =>
      chat.workspaceId === workspaceId &&
      chat.executionHostId === executionHostId &&
      !openTabs.some(
        (tab) =>
          tab.contentType === 'agent-session' &&
          tab.entityId === chat.sessionId &&
          tab.executionHostId === executionHostId
      )
  )
}
