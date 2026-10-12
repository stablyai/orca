import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import { projectStructuredAgentSessionStatusState } from '../../../../shared/structured-agent-session-projection'
import { isActionableStructuredAgentSessionPrompt } from '../../../../shared/structured-agent-session-live-turn'

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
    // The host's answer where it gives one: a prompt an agent that ended raised waits on no one.
    projection.pendingPromptIds.filter((itemId) =>
      isActionableStructuredAgentSessionPrompt(itemId, state.actionablePromptIds)
    ),
    request?.turnState !== 'running' ? [request?.kind, request?.id, request?.outcome] : null
  ])
  observations.set(state, key)
  return key
}
