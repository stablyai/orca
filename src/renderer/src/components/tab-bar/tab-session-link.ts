import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/tab-types'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForTab
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'

export function isLinkableChatTab(state: AppState, tab: Tab | undefined): tab is Tab {
  return Boolean(
    tab?.contentType === 'agent-session' && structuredAgentSessionTargetForTab(state, tab) !== null
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
  const target = structuredAgentSessionTargetForTab(state, clicked)
  if (!target) {
    return null
  }
  const active = state.activeWorktreeId
    ? (state.getActiveTab(state.activeWorktreeId) ?? undefined)
    : undefined
  const source =
    isLinkableChatTab(state, active) &&
    structuredAgentSessionOwnerForTab(state, active) ===
      structuredAgentSessionOwnerForTab(state, clicked) &&
    active.entityId !== clicked.entityId
      ? active
      : clicked
  return {
    target,
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
