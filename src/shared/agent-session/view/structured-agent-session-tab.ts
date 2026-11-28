import { isStructuredAgentId } from '../lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  chatPaneKeySessionId,
  structuredAgentSessionTabId
} from './structured-agent-session-projection'
import { parsePaneKey } from '../../workspace-layout/stable-pane-id'
import {
  isStructuredAgentSessionHostTabId,
  structuredAgentSessionHostTabId
} from './structured-agent-session-host-tab-id'

/** Read only necessary fields so clients with different tab shapes share the registered-agent tab predicate. */
export function isStructuredTab<T extends { contentType?: string; agentSessionAgent?: unknown }>(
  tab: T
): tab is T & { contentType: 'agent-session' } {
  return tab.contentType === 'agent-session' && isStructuredAgentId(tab.agentSessionAgent)
}

/** The session a structured tab id names, or null for any other tab id. */
export function structuredAgentSessionIdOfTab(tabId: string): string | null {
  const prefix = structuredAgentSessionTabId('')
  return tabId.startsWith(prefix) && tabId.length > prefix.length
    ? tabId.slice(prefix.length)
    : null
}

/** The tab `id` names: that tab itself, else the chat tab whose session a legacy-derived id names. */
export function findTabByIdOrChatAlias<
  T extends { id: string; contentType?: string; entityId?: string | null }
>(tabs: readonly T[] | undefined, id: string): T | undefined {
  const sessionId =
    structuredAgentSessionIdOfTab(id) ??
    (isStructuredAgentSessionHostTabId(id)
      ? id.slice(structuredAgentSessionHostTabId('').length)
      : null)
  let chat: T | undefined
  for (const tab of tabs ?? []) {
    if (tab.id === id) {
      return tab
    }
    if (!chat && sessionId && tab.contentType === 'agent-session' && tab.entityId === sessionId) {
      chat = tab
    }
  }
  return chat
}

/** A canonical chat pane key addresses its conversation before the tab id embedded in that key. */
export function findTabByChatPaneKey<
  T extends { id: string; contentType?: string; entityId?: string | null }
>(tabs: readonly T[] | undefined, paneKey: string): T | undefined {
  const sessionId = chatPaneKeySessionId(paneKey)
  if (sessionId) {
    return (tabs ?? []).find(
      (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
    )
  }
  const tabId = parsePaneKey(paneKey)?.tabId
  return tabId === undefined ? undefined : (tabs ?? []).find((tab) => tab.id === tabId)
}
