import type { AgentRunAccount } from '../../../../shared/agent-run-account'
import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { AgentStatusMetadata } from './agent-status-contract'

/** Only the host writes the facet; a renderer-local row keeps what the host last said for that agent. */
export function resolveLiveEntryRunAccount(
  existing: AgentStatusEntry | undefined,
  metadata: AgentStatusMetadata | undefined,
  agentType: AgentType | undefined
): AgentRunAccount | undefined {
  if (metadata?.runAccount !== undefined) {
    return metadata.runAccount ?? undefined
  }
  return existing && existing.agentType === agentType ? existing.runAccount : undefined
}
