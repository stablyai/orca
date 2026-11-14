import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { statusEntryWslDistro } from '../../../../../shared/agent-session/lifecycle/saved-agent-summary'
import type { AgentStatusRouting } from './agent-status-contract'

/** Where a live entry's agent runs: the row's transport authority (else the entry's, else its
 *  pane's saved record's), and the WSL distro its relay named. */
export function agentStatusEntryExecutionScope(
  routing: AgentStatusRouting | undefined,
  existing: AgentStatusEntry | undefined,
  sleeping: SleepingAgentSessionRecord | undefined,
  agentType: AgentStatusEntry['agentType']
): Pick<AgentStatusEntry, 'connectionId' | 'wslDistro'> {
  const connectionId =
    routing?.connectionId !== undefined
      ? routing.connectionId
      : existing?.connectionId !== undefined
        ? existing.connectionId
        : sleeping?.connectionId
  return {
    ...(connectionId !== undefined ? { connectionId } : {}),
    ...statusEntryWslDistro(routing?.wslDistro, existing, agentType)
  }
}
