import {
  agentTurnEndedOnPurpose,
  agentVerdictDisplayMark,
  type AgentMainAgentVerdictSource
} from './agent-main-agent-verdict'
import { detectAgentStatusFromTitle } from './agent-detection'

/** Share activity/news policy between the host transition detector and sidebar sort stamps. */

/** Wait out brief done→working milestones before announcing finishes; goal/mission agents report these. */
export const AGENT_DONE_QUIET_MS = 1_500

/** One agent pane's phase. A pane at rest has no agent turn to report. */
export type AgentPhase = 'needs-you' | 'done' | 'working' | 'rest'

/** Only errored means unsolicited failure/cutoff, never user Stop; approval resumes stay in the same turn and are not news. */
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

/** Phase changes alone cannot distinguish failure from finish; hookRowTransition uses verdicts. */
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

/** Session boundaries settle a pane without completing a turn: phase becomes done with no news. */
export function hookRowTransition(
  from: AgentPhase,
  to: AgentPhase,
  row: AgentMainAgentVerdictSource & { sessionBoundary?: boolean }
): AgentTransition | null {
  if (to === 'done' && row.sessionBoundary === true) {
    return null
  }
  const transition = agentPhaseTransition(from, to)
  return transition === 'turn-finished' && agentVerdictDisplayMark(row) === 'failed'
    ? 'errored'
    : transition
}
