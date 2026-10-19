import {
  agentTurnEndedOnPurpose,
  agentVerdictDisplayMark,
  type AgentMainAgentVerdictSource
} from './agent-main-agent-verdict'
import { detectAgentStatusFromTitle } from './agent-detection'

/**
 * The one definition of what an agent pane is doing and which changes are news. The host's
 * transition detector and the sidebar's sort stamps both read it.
 */

/** One agent pane's phase. A pane at rest has no agent turn to report. */
export type AgentPhase = 'needs-you' | 'done' | 'working' | 'rest'

/**
 * A change worth telling someone about. `errored` is a turn that failed or was cut off, not one the
 * user stopped. Resuming after an approval is no change: it is the same turn.
 */
export type AgentTransition = 'prompt-submitted' | 'turn-finished' | 'errored' | 'needs-input'

/** A hook row's phase. A turn the user stopped is not news, so it rests. */
export function hookRowAgentPhase(row: AgentMainAgentVerdictSource): AgentPhase {
  switch (row.state) {
    case 'blocked':
    case 'waiting':
      return 'needs-you'
    case 'working':
      return 'working'
    case 'done':
      return agentTurnEndedOnPurpose(row) ? 'rest' : 'done'
  }
}

/** A hookless agent's phase from its terminal title, by the heuristic Smart's dots use. */
export function titleAgentPhase(title: string): AgentPhase {
  switch (detectAgentStatusFromTitle(title)) {
    case 'permission':
      return 'needs-you'
    case 'working':
      return 'working'
    case 'idle':
      return 'done'
    case null:
      return 'rest'
  }
}

/** A pane's phase after observing `observed`. Done only follows a turn. */
export function nextAgentPhase(previous: AgentPhase, observed: AgentPhase): AgentPhase {
  return observed === 'done' && previous === 'rest' ? 'rest' : observed
}

/**
 * The news in a phase change, or null when there is none. Phases alone cannot tell a failed turn
 * from a finish; {@link hookRowTransition} can.
 */
export function agentPhaseTransition(from: AgentPhase, to: AgentPhase): AgentTransition | null {
  if (from === to) {
    return null
  }
  switch (to) {
    case 'needs-you':
      return 'needs-input'
    case 'done':
      return 'turn-finished'
    case 'working':
      return from === 'needs-you' ? null : 'prompt-submitted'
    case 'rest':
      return null
  }
}

/** The news in a hook pane's change, given the row it moved to. */
export function hookRowTransition(
  from: AgentPhase,
  to: AgentPhase,
  row: AgentMainAgentVerdictSource
): AgentTransition | null {
  const transition = agentPhaseTransition(from, to)
  return transition === 'turn-finished' && agentVerdictDisplayMark(row) === 'failed'
    ? 'errored'
    : transition
}
