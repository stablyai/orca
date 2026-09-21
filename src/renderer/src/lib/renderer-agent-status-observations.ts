import {
  AgentStatusObservationSequencer,
  createAgentStatusAuthorityId
} from '../../../shared/agent-status-observation'

/**
 * The renderer's sequencer for status rows it writes itself: remote-runtime OSC bytes it
 * parses locally, launch seeds, and Command Code output seeds. Deliberately a SECOND
 * authority — rows main sequenced arrive already stamped and keep main's id, so the two
 * clocks that today share one `updatedAt` comparison become visible instead of implied.
 *
 * Nothing reads it yet (STA-4293). See shared/agent-status-observation.ts for the rule that
 * ids from different authorities are incomparable, not merely older.
 */
export const rendererAgentStatusObservations = new AgentStatusObservationSequencer(
  createAgentStatusAuthorityId('renderer')
)
