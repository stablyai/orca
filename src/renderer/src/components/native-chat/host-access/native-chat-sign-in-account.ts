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

type Submission = Pick<AgentJournalSubmission, 'dispatchState' | 'rejection' | 'submittedSequence'>

/** The chat's current failure: the newer of its latest unresolved failure line and its latest
 *  send, when that send was refused. A send that went through after the line, or a successful turn
 *  after either, leaves none. */
function currentFailure(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly Submission[]
): AgentSessionFailureFact | undefined {
  const { line, resolvedAt } = agentSessionLatestFailureLine(items)
  const latest = submissions.at(-1)
  // Older hosts don't say where a send sits; it is then taken as the newest thing that happened.
  const sentAt = latest ? (latest.submittedSequence ?? Number.POSITIVE_INFINITY) : null
  if (
    latest &&
    sentAt !== null &&
    sentAt > resolvedAt &&
    sentAt > (line?.sequence ?? Number.NEGATIVE_INFINITY)
  ) {
    return latest.dispatchState === 'rejected'
      ? readAgentSessionFailureFact(latest.rejection)
      : undefined
  }
  return line?.fact
}

/** Which account a chat's sign-in is for: the host's verdict or the failed launch, else the chat's
 *  current failure, else the bot kickoff's refusal. A failure that no longer stands names none. */
export function nativeChatSignInAccount(input: {
  unavailable: AgentSessionUnavailable | null | undefined
  launchDetails: unknown
  items: readonly AgentJournalRenderItem[]
  submissions: readonly Submission[] | undefined
  kickoff?: { account?: AgentSessionAccountKind } | null
}): AgentSessionAccountKind | undefined {
  const details = input.launchDetails
  const current = currentFailure(input.items, input.submissions ?? [])
  return (
    (input.unavailable?.reason === 'notSignedIn' ? input.unavailable.account : undefined) ??
    (typeof details === 'object' && details !== null && 'account' in details
      ? accountKind(details.account)
      : undefined) ??
    (current?.kind === 'notSignedIn' ? current.account : undefined) ??
    input.kickoff?.account
  )
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
