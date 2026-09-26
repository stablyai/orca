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

/**
 * What one session was doing at the stop-time snapshot that decided its offer — the description IS
 * the offer's own capture, never re-read from the journal, which the provider rewrites in its own
 * words on reattach. `state` is the MAIN agent's own state in the status-store vocabulary; live
 * child work is carried in `tasks`, not folded into it, so a settled lead with running subagents
 * reads `done` plus its tasks. No ids: this is display, and an id would tempt a reader to re-derive.
 */
export type AgentSessionRestartActivity = {
  state: AgentStatusState
  prompts: AgentSessionRestartPrompt[]
  tasks: AgentSessionRestartTask[]
}
