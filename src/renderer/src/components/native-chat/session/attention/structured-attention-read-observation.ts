import type { StructuredAgentSessionState } from '../../../../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import { projectStructuredAgentSessionStatusState } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { isActionableStructuredAgentSessionPrompt } from '../../../../../../shared/agent-session/view/structured-agent-session-live-turn'
import { agentJournalSubmissionsDifferOnlyInStamp } from '../../../../../../shared/agent-session/journal/agent-session-journal-written-stamp'

const observations = new WeakMap<StructuredAgentSessionState, string>()
// The newest observation per loaded item list, so a state that differs only by a written stamp reuses it.
const byItems = new WeakMap<
  StructuredAgentSessionState['items'],
  { state: StructuredAgentSessionState; key: string }
>()

export function structuredAttentionReadObservation(state: StructuredAgentSessionState): string {
  const cached = observations.get(state) ?? stampOnlyObservation(state)
  if (cached !== undefined) {
    observations.set(state, cached)
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
  byItems.set(state.items, { state, key })
  return key
}

/** The key never reads `writtenAt`, so a stamp-only restatement keeps the previous one. */
function stampOnlyObservation(state: StructuredAgentSessionState): string | undefined {
  const previous = byItems.get(state.items)
  if (
    !previous ||
    previous.state.fence !== state.fence ||
    previous.state.cursor?.epoch !== state.cursor?.epoch ||
    !sameIds(previous.state.actionablePromptIds, state.actionablePromptIds) ||
    !agentJournalSubmissionsDifferOnlyInStamp(previous.state.submissions, state.submissions)
  ) {
    return undefined
  }
  byItems.set(state.items, { state, key: previous.key })
  return previous.key
}

function sameIds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.length === b.length &&
      a.every((id, index) => id === b[index]))
  )
}
