import { isStructuredAgentId } from './agent-session-provider-handle'

/** A chat tab of any agent its host registered; the host publishes tabs of no other agent. Takes
 *  only the fields it reads, so readers with their own tab shape share this one predicate. */
export function isStructuredTab<T extends { contentType?: string; agentSessionAgent?: unknown }>(
  tab: T
): tab is T & { contentType: 'agent-session' } {
  return tab.contentType === 'agent-session' && isStructuredAgentId(tab.agentSessionAgent)
}
