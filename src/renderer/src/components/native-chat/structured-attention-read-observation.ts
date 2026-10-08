import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import { projectStructuredAgentSessionStatusState } from '../../../../shared/structured-agent-session-projection'

const observations = new WeakMap<StructuredAgentSessionState, string>()

export function structuredAttentionReadObservation(state: StructuredAgentSessionState): string {
  const cached = observations.get(state)
  if (cached !== undefined) {
    return cached
  }
  const projection = projectStructuredAgentSessionStatusState(
    state.items,
    state.submissions,
    state.fence ?? undefined
  )
  const request = projection.latestRequest
  const key = JSON.stringify([
    state.cursor?.epoch,
    projection.pendingPromptIds,
    request?.turnState !== 'running' ? [request?.kind, request?.id, request?.outcome] : null
  ])
  observations.set(state, key)
  return key
}
