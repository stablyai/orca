import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/tab-types'
import { structuredAgentSessionOwnerForTab } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'

export function isLinkableChatTab(state: AppState, tab: Tab | undefined): tab is Tab {
  return Boolean(
    tab?.contentType === 'agent-session' &&
    (tab.agentSessionAgent === 'claude' || tab.agentSessionAgent === 'codex') &&
    structuredAgentSessionOwnerForTab(state, tab) === 'local'
  )
}

export function tabSessionLinkRequest(
  state: AppState,
  workspaceId: string,
  tabId: string,
  names?: ReadonlyMap<string, { conversationName?: string | null }>
) {
  const clicked = state.unifiedTabsByWorktree[workspaceId]?.find((tab) => tab.id === tabId)
  if (!isLinkableChatTab(state, clicked)) {
    return null
  }
  const active = state.activeWorktreeId
    ? (state.getActiveTab(state.activeWorktreeId) ?? undefined)
    : undefined
  const source =
    isLinkableChatTab(state, active) && active.entityId !== clicked.entityId ? active : clicked
  return {
    sessionId: source.entityId,
    sourceName: source.customLabel ?? names?.get(source.entityId)?.conversationName ?? source.label,
    ...(source.entityId !== clicked.entityId
      ? {
          partnerSessionId: clicked.entityId,
          partnerName:
            clicked.customLabel ?? names?.get(clicked.entityId)?.conversationName ?? clicked.label
        }
      : {})
  }
}
