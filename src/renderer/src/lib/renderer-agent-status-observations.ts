import {
  AgentStatusObservationSequencer,
  createAgentStatusAuthorityId
} from '../../../shared/agent-status-observation'

/** Sequence only renderer-owned remote-runtime OSC/launch/Command Code seeds; main-stamped rows retain main’s authority. Observation IDs across authorities are incomparable (shared/agent-status-observation.ts); not yet consumed (STA-4293). */
export const rendererAgentStatusObservations = new AgentStatusObservationSequencer(
  createAgentStatusAuthorityId('renderer')
)
