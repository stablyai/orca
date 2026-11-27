import type { StructuredAgentSessionState } from '../../../../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import { projectStructuredAgentSessionStatusState } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { isActionableStructuredAgentSessionPrompt } from '../../../../../../shared/agent-session/view/structured-agent-session-live-turn'
import { rowsBesideStreamedText } from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'

const observations = new WeakMap<StructuredAgentSessionState, string>()
type ObservedInputs = Pick<
  StructuredAgentSessionState,
  'submissions' | 'fence' | 'actionablePromptIds'
>
// The key never reads reply text, so a streaming reply reuses the answer for its rows.
const byRows = new WeakMap<
  readonly AgentJournalRenderItem[],
  { inputs: ObservedInputs; epoch: string | undefined; key: string }
>()

export function structuredAttentionReadObservation(state: StructuredAgentSessionState): string {
  const cached = observations.get(state)
  if (cached !== undefined) {
    return cached
  }
  const rows = rowsBesideStreamedText(state.items)
  const prior = byRows.get(rows)
  if (
    prior &&
    prior.epoch === state.cursor?.epoch &&
    prior.inputs.submissions === state.submissions &&
    prior.inputs.fence === state.fence &&
    prior.inputs.actionablePromptIds === state.actionablePromptIds
  ) {
    observations.set(state, prior.key)
    return prior.key
  }
  const projection = projectStructuredAgentSessionStatusState(
    rows,
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
  const { submissions, fence, actionablePromptIds } = state
  byRows.set(rows, {
    inputs: { submissions, fence, actionablePromptIds },
    epoch: state.cursor?.epoch,
    key
  })
  return key
}
