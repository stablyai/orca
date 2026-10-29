import type { AgentChildWorkKind } from './agent-status-child-work'
import type { AgentStatusState } from './agent-status-types'

/** A prompt the session was waiting on the user for when the stop cut it off. */
export type AgentSessionRestartPrompt = { kind: 'approval' | 'question'; label: string }

/** A child the stop cut off: a subagent, background command, monitor or workflow. */
export type AgentSessionRestartTask = { kind: AgentChildWorkKind; label: string }

/** Bounded because the activity is persisted in the recovery capsule and sent on the wire. */
export const AGENT_SESSION_RESTART_ACTIVITY_MAX_PROMPTS = 4
export const AGENT_SESSION_RESTART_ACTIVITY_MAX_TASKS = 16
export const AGENT_SESSION_RESTART_ACTIVITY_MAX_LABEL_LENGTH = 200

/** Capture display activity with the stop-time offer, never re-read rewritten history after reattach. state is the lead's own status; surviving children live in tasks (done lead plus running tasks). Omit IDs to prevent re-derivation. */
export type AgentSessionRestartActivity = {
  state: AgentStatusState
  prompts: AgentSessionRestartPrompt[]
  tasks: AgentSessionRestartTask[]
}
