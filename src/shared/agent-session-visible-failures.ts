import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from './agent-session-failure'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { isStructuredAgentSessionStartFailureRow } from './structured-agent-session-start-failure-row-key'

/** Loaded startup causes and authentication explanations already visible in the transcript.
 *  Only the session's own rows count: a subagent's rows are folded away or collapsed. */
export function agentSessionVisibleFailureFacts(
  items: readonly AgentJournalRenderItem[]
): AgentSessionFailureFact[] {
  const facts: AgentSessionFailureFact[] = []
  for (const item of items) {
    if (item.body.kind === 'status' && isRootAgentJournalItem(item)) {
      const fact = readWholeAgentSessionFailureFact(item.body.failure)
      if (
        fact &&
        (isStructuredAgentSessionStartFailureRow(item.itemId) || fact.kind === 'notSignedIn')
      ) {
        facts.push(fact)
      }
    }
  }
  return facts
}

/** Whether two facts are one failure: a start's row and the messages it rejected share one. */
export function sameAgentSessionFailureFact(
  a: AgentSessionFailureFact,
  b: AgentSessionFailureFact
): boolean {
  return (
    a.kind === b.kind &&
    a.account === b.account &&
    a.detail?.text === b.detail?.text &&
    a.detail?.audience === b.detail?.audience &&
    a.refusal?.code === b.refusal?.code &&
    a.refusal?.details?.reason === b.refusal?.details?.reason &&
    a.attachment?.reason === b.attachment?.reason &&
    a.attachment?.limit === b.attachment?.limit &&
    a.retry?.error === b.retry?.error &&
    a.retry?.status === b.retry?.status
  )
}

/** Whether a loaded row already states this failure, comparing facts rather than wording. */
export function agentSessionFailureStatedByRow(
  failure: unknown,
  statedFailures: readonly AgentSessionFailureFact[]
): boolean {
  const fact = readWholeAgentSessionFailureFact(failure)
  return (
    fact !== undefined && statedFailures.some((stated) => sameAgentSessionFailureFact(stated, fact))
  )
}
