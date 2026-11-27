import { isCustomAcpAgentId } from './custom-acp-agents'

// Each process learns them where it can: the host from its settings, a client from the hosts' agent lists.
const names = new Map<string, string>()

/** Records the names of custom ACP agents; ids are `custom-<id>`, the same on every host. */
export function nameCustomAcpAgents(agents: Iterable<{ agent: string; name?: string }>): void {
  for (const { agent, name } of agents) {
    if (isCustomAcpAgentId(agent) && name) {
      names.set(agent, name)
    }
  }
}

export function customAcpAgentName(agent: string): string | undefined {
  return names.get(agent)
}
