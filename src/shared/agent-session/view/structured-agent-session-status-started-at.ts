import { finishAgentSessionSteps } from '../agent-session-projection-steps'
// Date status from own turn/send/prompt edges, never newest-row time: child output would keep redating an idle lead.
// Turn records need no producer filter because they never carry child linkage (structured-agent-session-live-turn.ts).

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'
import { readAgentJournalTurn } from '../lifecycle/agent-session-turn-record'
import type { StructuredAgentSessionProjectedStatus } from './structured-agent-session-projection'
import type { StructuredAgentSessionLatestRequest } from '../requests/structured-agent-session-latest-request'
import type { AgentSessionStatusSummary } from '../agent-session-wire'
import type { AgentMainAgentStatus } from '../../agent-status/lifecycle/main-agent-status'
import type { AgentStatusState } from '../../agent-status/contracts/agent-status-types'
import { isUnansweredStructuredAgentSessionDispatch } from '../requests/structured-agent-session-unanswered-dispatch'

/** Undefined when the journal records no edge that dates `status`; readers keep their own rule. */
export function structuredAgentSessionStatusStartedAt(
  status: StructuredAgentSessionProjectedStatus,
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  currentFence: number | null | undefined,
  latestRequest: Pick<StructuredAgentSessionLatestRequest, 'settledAt'> | null
): number | undefined {
  return finishAgentSessionSteps(
    structuredAgentSessionStatusStartedAtSteps(
      status,
      items,
      submissions,
      currentFence,
      latestRequest
    )
  )
}

export function* structuredAgentSessionStatusStartedAtSteps(
  status: StructuredAgentSessionProjectedStatus,
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  currentFence: number | null | undefined,
  latestRequest: Pick<StructuredAgentSessionLatestRequest, 'settledAt'> | null
): Generator<void, number | undefined> {
  if (status === 'attention') {
    return yield* oldestPendingPromptAtSteps(items)
  }
  if (status === 'idle') {
    // The session went idle when the request it reports settled, not when its newest turn did.
    return latestRequest?.settledAt
  }
  const turnItem = yield* newestTurnItemSteps(items)
  const turn = readAgentJournalTurn(turnItem?.body)
  if (turnItem && turn?.state === 'running') {
    // A mid-turn send joins the running turn; it does not restart the stretch.
    return turn.requestedAt ?? turn.startedAt ?? turnItem.observedAt
  }
  let earliest: number | undefined
  for (const submission of submissions) {
    yield

    if (
      isUnansweredStructuredAgentSessionDispatch(submission, currentFence) &&
      (earliest === undefined || submission.submittedAt < earliest)
    ) {
      earliest = submission.submittedAt
    }
  }
  return earliest
}

export function* newestTurnItemSteps(
  items: readonly AgentJournalRenderItem[]
): Generator<void, AgentJournalRenderItem | null> {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    yield

    const item = items[index]
    if (item && readAgentJournalTurn(item.body)) {
      return item
    }
  }
  return null
}

/** The session's own ask when it has one; a subagent's only when that alone holds the session. */

export function* oldestPendingPromptAtSteps(
  items: readonly AgentJournalRenderItem[]
): Generator<void, number | undefined> {
  let own: number | undefined
  let subagent: number | undefined
  for (const item of items) {
    yield

    if (
      (item.body.kind !== 'approval' && item.body.kind !== 'question') ||
      item.body.resolution.state !== 'pending'
    ) {
      continue
    }
    if (isRootAgentJournalItem(item)) {
      own = Math.min(own ?? item.observedAt, item.observedAt)
    } else {
      subagent = Math.min(subagent ?? item.observedAt, item.observedAt)
    }
  }
  return own ?? subagent
}

/** The main agent's own status, dated by the host when it published a clock. */
export function structuredAgentSessionDatedMainAgent<T extends object>(
  mainAgent: T,
  summary: Pick<AgentSessionStatusSummary, 'statusStartedAt'>
): T & { stateStartedAt?: number } {
  return summary.statusStartedAt === undefined
    ? mainAgent
    : { ...mainAgent, stateStartedAt: summary.statusStartedAt }
}

/** Use the host clock only while the row shows the lead’s state; child-held rows retain the writer’s continuity rule. */
export function structuredAgentSessionRowStateStartedAt(
  row: { state: AgentStatusState; mainAgent: Pick<AgentMainAgentStatus, 'state'> },
  summary: Pick<AgentSessionStatusSummary, 'statusStartedAt'>
): number | undefined {
  return row.state === row.mainAgent.state ? summary.statusStartedAt : undefined
}
