import { isStructuredAgentId } from '../lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from './structured-agent-session-projection'

/** Read only necessary fields so clients with different tab shapes share the registered-agent tab predicate. */
export function isStructuredTab<T extends { contentType?: string; agentSessionAgent?: unknown }>(
  tab: T
): tab is T & { contentType: 'agent-session' } {
  return tab.contentType === 'agent-session' && isStructuredAgentId(tab.agentSessionAgent)
}

/** The pane key a session's status row is published under, whether or not it has a tab. */
export function structuredAgentSessionStatusPaneKey(sessionId: string): string {
  return structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
}

/** The session a structured tab id names, or null for any other tab id. */
export function structuredAgentSessionIdOfTab(tabId: string): string | null {
  const prefix = structuredAgentSessionTabId('')
  return tabId.startsWith(prefix) && tabId.length > prefix.length
    ? tabId.slice(prefix.length)
    : null
}
