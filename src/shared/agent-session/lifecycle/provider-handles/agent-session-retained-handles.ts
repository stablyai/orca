import type { AgentSessionRecord } from '../agent-session-record'
import type { AgentSessionProviderHandleLink } from './agent-session-provider-handle'

/** The current handle and the most recent handle of each provider a chat can return to. */
export function retainedProviderHandles({
  providerHandleChain
}: Pick<AgentSessionRecord, 'providerHandleChain'>): AgentSessionProviderHandleLink[] {
  const retained = new Map<string, AgentSessionProviderHandleLink>()
  for (const link of providerHandleChain) {
    retained.set(link.handle.agent, link)
  }
  return [...retained.values()]
}
