import { isStructuredAgentId } from './agent-session-provider-handle'

/** Read only necessary fields so clients with different tab shapes share the registered-agent tab predicate. */
export function isStructuredTab<T extends { contentType?: string; agentSessionAgent?: unknown }>(
  tab: T
): tab is T & { contentType: 'agent-session' } {
  return tab.contentType === 'agent-session' && isStructuredAgentId(tab.agentSessionAgent)
}
