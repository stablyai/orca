import {
  mainAgentStatusEqual,
  type AgentMainAgentStatus,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { AgentStatusObservationOrigin } from '../../../../shared/agent-status-observation'
import type { AgentStatusPayload } from './agent-status-contract'

/** Byte- and launch-derived writers never carry a main agent fact; a hook row without one means the
 *  host has none, so keeping ours would diverge from what the host serves mobile and the CLI. */
const MAIN_AGENT_BLIND_ORIGINS: ReadonlySet<AgentStatusObservationOrigin> = new Set([
  'osc',
  'title',
  'launch',
  'process'
])

/** The main agent fact a live entry carries. A writer with no main agent fact of its own (OSC bytes, launch
 *  seeds) repaints the state the row already holds, and the main agent behind an unchanged state is
 *  unchanged too — the same rule main's OSC ingest applies. The existing object is reused when
 *  nothing changed so subscribers can compare by reference. */
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
