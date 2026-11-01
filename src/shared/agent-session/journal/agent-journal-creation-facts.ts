import type { AgentMessageSender } from '../agent-session-message-source'

/** Display-only creation fact; survives removal of the orchestration Task and Dispatch. */
export type AgentJournalAgentStartItem = {
  kind: 'agent-start'
  dispatchId: string
  worker: AgentMessageSender
  task: string
}

/** Display-only creation fact for an agent this chat's agent launched on its own (`orca agent launch`),
 *  not a supervised worker: `launchId` is the launch operation, `agent` the launched conversation. */
export type AgentJournalAgentHandoffItem = {
  kind: 'agent-handoff'
  launchId: string
  agent: AgentMessageSender
  task: string
}
