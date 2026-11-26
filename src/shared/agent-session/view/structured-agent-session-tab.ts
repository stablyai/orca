import { isStructuredAgentId } from '../lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { structuredAgentSessionTabId } from './structured-agent-session-projection'
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

/** The tab `id` names: a chat whose session a legacy-derived id names, else that tab itself. */
export function findTabByIdOrChatAlias<
  T extends { id: string; contentType?: string; entityId?: string | null }
>(tabs: readonly T[] | undefined, id: string): T | undefined {
  const sessionId =
    structuredAgentSessionIdOfTab(id) ??
    (isStructuredAgentSessionHostTabId(id)
      ? id.slice(structuredAgentSessionHostTabId('').length)
      : null)
  let exact: T | undefined
  for (const tab of tabs ?? []) {
    if (tab.id === id) {
      exact = tab
    }
    if (sessionId && tab.contentType === 'agent-session' && tab.entityId === sessionId) {
      return tab
    }
  }
  return exact
}
