import type { StructuredAgentSessionLaunchLifecycle } from './structured-agent-session-launch-registry'
import type { StructuredLaunchState } from './structured-agent-session-launch-state-store'

export function launchStateLifecycle(
  state: StructuredLaunchState
): StructuredAgentSessionLaunchLifecycle {
  if (state.cancelled || state.callers.outcome === 'cancelled') {
    return 'cancelled'
  }
  if (state.callers.outcome === 'published') {
    return 'published'
  }
  if (state.visibilityUnknown || state.callers.outcome === 'unknown') {
    return 'visibility-unknown'
  }
  return state.callers.outcome === 'failed' ? 'failed' : 'pending'
}
