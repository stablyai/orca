import { agentSessionExecutionLocationsEqual } from './agent-session-record'
import type { AgentJournalCursor } from './agent-session-journal-types'
import type { AgentSessionExecutionLocation } from './agent-session-record'
import type { StructuredAgentSessionProjectedStatus } from './structured-agent-session-projection'

/** Current host evidence, independently ordered from durable transcript history. */
export type AgentSessionExecutionView = {
  sessionId: string
  location: AgentSessionExecutionLocation
  acquisitionGeneration?: string | null
  hostIncarnation: string
  revision: number
  fence: number
  cursor: AgentJournalCursor
  observation: 'live' | 'unverifiable' | 'exited' | 'none'
  activity: 'working' | 'attention' | 'idle' | 'unverifiable'
  control: 'native' | 'tui' | 'none'
  turnId: string | null
  promptIds: string[]
  recovery: boolean
  /** The compatibility projection for readers predating execution evidence. */
  historicalStatus: StructuredAgentSessionProjectedStatus | null
}

export function executionViewStatus(
  view: AgentSessionExecutionView
): StructuredAgentSessionProjectedStatus | null {
  if (view.activity === 'unverifiable') {
    return 'attention'
  }
  return view.historicalStatus === null && view.activity === 'idle' ? null : view.activity
}

/** Revocations apply immediately; positive claims wait for their referenced journal state. */
export function joinAgentSessionExecutionView(
  previous: AgentSessionExecutionView | undefined,
  incoming: AgentSessionExecutionView | undefined,
  cursor: AgentJournalCursor | null
): AgentSessionExecutionView | undefined {
  if (
    previous &&
    incoming &&
    (previous.sessionId !== incoming.sessionId ||
      !agentSessionExecutionLocationsEqual(previous.location, incoming.location))
  ) {
    return previous
  }
  if (!incoming) {
    return previous
  }
  if (
    previous?.hostIncarnation === incoming.hostIncarnation &&
    previous.revision >= incoming.revision
  ) {
    return previous
  }
  if (incoming.control === 'none' || incoming.observation !== 'live') {
    return incoming
  }
  if (cursor?.epoch !== incoming.cursor.epoch || cursor.sequence < incoming.cursor.sequence) {
    return previous
  }
  return incoming
}
