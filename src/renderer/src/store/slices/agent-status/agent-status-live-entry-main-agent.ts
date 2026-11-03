import '../../../../../shared/agent-status-types'
import {
  mainAgentStatusEqual,
  type AgentMainAgentStatus
} from '../../../../../shared/main-agent-status'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import type { AgentStatusObservationOrigin } from '../../../../../shared/agent-status-observation'
import type { AgentStatusPayload } from './agent-status-contract'

/** Byte/launch writers omit mainAgent; hook omission authoritatively clears it for mobile/CLI parity. */
const MAIN_AGENT_BLIND_ORIGINS: ReadonlySet<AgentStatusObservationOrigin> = new Set([
  'osc',
  'title',
  'launch',
  'process'
])

/** Clockless OSC/launch repaints retain mainAgent within unchanged state, like main ingest. Reuse equal objects for reference subscribers. */
export function resolveAgentStatusLiveEntryMainAgent(
  existing: AgentStatusEntry | undefined,
  payload: Pick<AgentStatusPayload, 'state' | 'mainAgent' | 'observation'>,
  agentType: AgentStatusEntry['agentType']
): AgentMainAgentStatus | undefined {
  const blindWriter =
    payload.observation !== undefined && MAIN_AGENT_BLIND_ORIGINS.has(payload.observation.origin)
  const next =
    payload.mainAgent ??
    (blindWriter && existing?.state === payload.state && existing.agentType === agentType
      ? existing.mainAgent
      : undefined)
  return mainAgentStatusEqual(existing?.mainAgent, next) ? existing?.mainAgent : next
}
