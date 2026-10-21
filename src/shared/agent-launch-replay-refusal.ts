/**
 * What an `agent.launchReplay` refusal proves about the launch, for every client that replays one.
 *
 * Kept in one place because the three answers call for opposite actions: `unsupported` means nothing
 * ran and the client may use its older launch path; `unknown` means the agent may be running and the
 * client must not launch again on its own; `failed` means the host refused before starting anything.
 */

import { AGENT_LAUNCH_PANE_ALREADY_LIVE_CODE } from './agent-launch-pane-already-live'
import { AGENT_LAUNCH_SESSION_ALREADY_EXISTS_CODE } from './agent-launch-session-already-exists'

export type AgentLaunchReplayRefusal = 'unsupported' | 'unknown' | 'failed'

/** The pane or chat the launch reserved is already held. */
export function isAgentLaunchReservationTakenRefusal(error: { code?: string }): boolean {
  return (
    error.code === AGENT_LAUNCH_PANE_ALREADY_LIVE_CODE ||
    error.code === AGENT_LAUNCH_SESSION_ALREADY_EXISTS_CODE
  )
}

/** An older host rejects the method rather than a field. */
export function isAgentLaunchReplayUnsupportedRefusal(error: { code?: string }): boolean {
  return (
    error.code === 'method_not_found' ||
    error.code === 'forbidden' ||
    error.code === 'agent_launch_replay_unsupported'
  )
}

export function classifyAgentLaunchReplayRefusal(
  error: { code?: string },
  replayed: boolean
): AgentLaunchReplayRefusal {
  if (isAgentLaunchReplayUnsupportedRefusal(error)) {
    // Only a refusal of the first send proves nothing ran; after a replay it may be a replacement
    // connection whose capability list hasn't landed, answering for an attempt that did start.
    return replayed ? 'unknown' : 'unsupported'
  }
  if (
    error.code === 'agent_session_operation_unknown' ||
    error.code === 'agent_session_operation_expired'
  ) {
    return 'unknown'
  }
  if (isAgentLaunchReservationTakenRefusal(error)) {
    // A taken reservation proves nothing started only on the first send; after a replay the pane
    // or chat holding it may be this launch's own.
    return replayed ? 'unknown' : 'failed'
  }
  return 'failed'
}
