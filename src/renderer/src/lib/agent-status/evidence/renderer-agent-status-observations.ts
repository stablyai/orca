import {
  AgentStatusObservationSequencer,
  createAgentStatusAuthorityId
} from '../../../../../shared/agent-status/contracts/agent-status-observation'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'

/** Sequence only renderer-owned remote-runtime OSC/launch/Command Code seeds; main-stamped rows retain main’s authority. Observation IDs across authorities are incomparable (shared/agent-status-observation.ts); not yet consumed (STA-4293). */
export const rendererAgentStatusObservations = new AgentStatusObservationSequencer(
  createAgentStatusAuthorityId('renderer')
)

/** An accepted host process row, unlike scrape facts alone, hands this producer to the host. */
export function hostOwnsCommandCodeStatus(
  row: Pick<AgentStatusEntry, 'agentType' | 'observation' | 'paneSleep'> | undefined
): boolean {
  return Boolean(
    row?.paneSleep ||
    (row?.agentType === 'command-code' &&
      row.observation?.origin === 'process' &&
      row.observation.authorityId !== rendererAgentStatusObservations.getAuthorityId())
  )
}
