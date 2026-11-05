import { activeStructuredAgentSessionTurnIdSteps } from './structured-agent-session-live-turn'
import { isStructuredAgentSessionMainAgentWorkingSteps } from './structured-agent-session-main-agent-working'
import { agentSessionCurrentContextRowsSteps } from '../agent-session-context-clear'
import { finishAgentSessionSteps } from '../agent-session-projection-steps'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'

import type { StructuredAgentSessionWorkScope } from './structured-agent-session-main-agent-working'

/** Journal main-agent rule: running turn or unanswered send, including work hidden beneath an attention prompt. */
export function owesStructuredAgentSessionWork(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null,
  scope?: StructuredAgentSessionWorkScope
): boolean {
  return finishAgentSessionSteps(
    owesStructuredAgentSessionWorkSteps(items, submissions, currentFence, scope)
  )
}

export function* owesStructuredAgentSessionWorkSteps(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null,
  scope?: StructuredAgentSessionWorkScope
): Generator<void, boolean> {
  const current = yield* agentSessionCurrentContextRowsSteps(items, submissions)
  return yield* isStructuredAgentSessionMainAgentWorkingSteps(
    yield* activeStructuredAgentSessionTurnIdSteps(
      current.items,
      scope && ((item) => scope.isCurrentItem(item.itemId))
    ),
    current.submissions,
    currentFence,
    scope
  )
}
