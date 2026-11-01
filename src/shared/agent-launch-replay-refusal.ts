/** Replay refusals guide clients: unsupported permits the older path, unknown forbids relaunch because work may exist, and failed proves nothing started. */

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
    // After replay, a replacement host without capabilities may be refusing an attempt that already started.
    return replayed ? 'unknown' : 'unsupported'
  }
  if (
    error.code === 'agent_session_operation_unknown' ||
    error.code === 'agent_session_operation_expired'
  ) {
    return 'unknown'
  }
  if (isAgentLaunchReservationTakenRefusal(error)) {
    // A replay's taken reservation may be this launch's own; only a first-send refusal proves no start.
    return replayed ? 'unknown' : 'failed'
  }
  return 'failed'
}
