// When the session's own agent entered the status it is in, read off its own lifecycle edges: its
// turn records, its sends, and the prompts holding it. Row timestamps never date it. Subagents
// write into the same journal and keep going after the session settles, and a clock over rows
// re-dates an idle session with every one of theirs.
//
// Turn records need no producer filter: a turn is the session's own unit of work and never carries
// subagent linkage (see the header of `structured-agent-session-live-turn.ts`).

import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import { readAgentJournalTurn } from './agent-session-turn-record'
import type { StructuredAgentSessionProjectedStatus } from './structured-agent-session-projection'
import type { StructuredAgentSessionLatestRequest } from './structured-agent-session-latest-request'
import type { AgentSessionStatusSummary } from './agent-session-wire'
import type { AgentMainAgentStatus } from './main-agent-status'
import type { AgentStatusState } from './agent-status-types'
import { isUnansweredStructuredAgentSessionDispatch } from './structured-agent-session-unanswered-dispatch'

/** Undefined when the journal records no edge that dates `status`; readers keep their own rule. */
export function structuredAgentSessionStatusStartedAt(
  status: StructuredAgentSessionProjectedStatus,
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  currentFence: number | null | undefined,
  latestRequest: Pick<StructuredAgentSessionLatestRequest, 'settledAt'> | null
): number | undefined {
  if (status === 'attention') {
    return oldestPendingPromptAt(items)
  }
  if (status === 'idle') {
    // The session went idle when the request it reports settled, not when its newest turn did.
    return latestRequest?.settledAt
  }
  const turnItem = newestTurnItem(items)
  const turn = readAgentJournalTurn(turnItem?.body)
  if (turnItem && turn?.state === 'running') {
    // A mid-turn send joins the running turn; it does not restart the stretch.
    return turn.requestedAt ?? turn.startedAt ?? turnItem.observedAt
  }
  let earliest: number | undefined
  for (const submission of submissions) {
    if (
      isUnansweredStructuredAgentSessionDispatch(submission, currentFence) &&
      (earliest === undefined || submission.submittedAt < earliest)
    ) {
      earliest = submission.submittedAt
    }
  }
  return earliest
}

function newestTurnItem(items: readonly AgentJournalRenderItem[]): AgentJournalRenderItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item && readAgentJournalTurn(item.body)) {
      return item
    }
  }
  return null
}

/** The session's own ask when it has one; a subagent's only when that alone holds the session. */
function oldestPendingPromptAt(items: readonly AgentJournalRenderItem[]): number | undefined {
  let own: number | undefined
  let subagent: number | undefined
  for (const item of items) {
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

/** The row's own start, when the host dated it: the row is showing the main agent's state rather
 *  than one child work holds open. Undefined leaves the writer's own continuity rule in charge. */
export function structuredAgentSessionRowStateStartedAt(
  row: { state: AgentStatusState; mainAgent: Pick<AgentMainAgentStatus, 'state'> },
  summary: Pick<AgentSessionStatusSummary, 'statusStartedAt'>
): number | undefined {
  return row.state === row.mainAgent.state ? summary.statusStartedAt : undefined
}
