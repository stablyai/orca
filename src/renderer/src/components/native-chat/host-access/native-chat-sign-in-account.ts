import type {
  AgentSessionAccountKind,
  AgentSessionUnavailable
} from '../../../../../shared/agent-session/failures/agent-session-availability'
import {
  readAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../../shared/agent-session/failures/agent-session-failure'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionLatestFailureLine } from '../../../../../shared/agent-session/failures/agent-session-visible-failures'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'

type Submission = Pick<
  AgentJournalSubmission,
  'clientMessageId' | 'dispatchState' | 'rejection' | 'resolvedAt' | 'submittedSequence'
>
type CurrentFailure = { fact: AgentSessionFailureFact; rowId: string; key: string }

/** The chat's current failure: the newer of its latest unresolved failure line and its latest
 *  send, when that send was refused. A send that went through after the line, or a successful turn
 *  after either, leaves none. */
function currentFailure(
  items: readonly AgentJournalRenderItem[],
  latest: Submission | undefined
): CurrentFailure | null {
  const { line, resolvedAt } = agentSessionLatestFailureLine(items)
  // Older hosts don't say where a send sits; it is then taken as the newest thing that happened.
  const sentAt = latest ? (latest.submittedSequence ?? Number.POSITIVE_INFINITY) : null
  if (
    latest &&
    sentAt !== null &&
    sentAt > resolvedAt &&
    sentAt > (line?.sequence ?? Number.NEGATIVE_INFINITY)
  ) {
    const fact =
      latest.dispatchState === 'rejected'
        ? readAgentSessionFailureFact(latest.rejection)
        : undefined
    const rowId = agentJournalSubmissionKey(latest.clientMessageId)
    return fact ? { fact, rowId, key: `${rowId}:${latest.resolvedAt ?? sentAt}` } : null
  }
  return line
    ? { fact: line.fact, rowId: line.itemId, key: `${line.itemId}:${line.sequence}` }
    : null
}

/** Which account a chat's sign-in is for: the host's verdict or the failed launch, else the chat's
 *  current failure, else the bot kickoff's refusal. A failure that no longer stands names none. */
export function nativeChatSignInContext(input: {
  unavailable: AgentSessionUnavailable | null | undefined
  launchDetails: unknown
  items: readonly AgentJournalRenderItem[]
  latestSubmission: Submission | undefined
  kickoff?: { account?: AgentSessionAccountKind } | null
}): { account: AgentSessionAccountKind | undefined; failure: CurrentFailure | null } {
  const details = input.launchDetails
  const current = currentFailure(input.items, input.latestSubmission)
  const failure = current?.fact.kind === 'notSignedIn' ? current : null
  const account =
    (input.unavailable?.reason === 'notSignedIn' ? input.unavailable.account : undefined) ??
    (typeof details === 'object' && details !== null && 'account' in details
      ? accountKind(details.account)
      : undefined) ??
    failure?.fact.account ??
    input.kickoff?.account
  return { account, failure }
}

function accountKind(value: unknown): AgentSessionAccountKind | undefined {
  return value === 'managed' || value === 'system' ? value : undefined
}

const AGY_SIGNED_OUT: AgentSessionUnavailable = { reason: 'notSignedIn', account: 'system' }

/** Before a chat on agy's own login sends anything, the host's known answer that agy is signed out
 *  says so, as a send refused for it would; once a message was sent, its own outcome says. */
export function nativeChatAgySignedOutBeforeSend(
  agySignedOut: boolean | undefined,
  submissions: readonly unknown[] | undefined
): AgentSessionUnavailable | null {
  return agySignedOut === true && (submissions?.length ?? 0) === 0 ? AGY_SIGNED_OUT : null
}
