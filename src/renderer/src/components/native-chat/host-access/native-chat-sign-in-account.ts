import type {
  AgentSessionAccountKind,
  AgentSessionUnavailable
} from '../../../../../shared/agent-session/failures/agent-session-availability'
import {
  readAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalSubmission } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

type Submission = Pick<AgentJournalSubmission, 'dispatchState' | 'rejection'>

/** Which account a chat's sign-in is for, from whichever of its failures said so: the host's
 *  verdict, a failed start, a failure line, or a refused send. Each may name it alone. */
export function nativeChatSignInAccount(input: {
  unavailable: AgentSessionUnavailable | null | undefined
  launchDetails: unknown
  startFailures: readonly AgentSessionFailureFact[]
  submissions: readonly Submission[] | undefined
  kickoff?: { account?: AgentSessionAccountKind } | null
}): AgentSessionAccountKind | undefined {
  const signedOut = (fact: AgentSessionFailureFact | undefined) =>
    fact?.kind === 'notSignedIn' ? fact.account : undefined
  const latestRejection = input.submissions?.findLast(
    (submission) => submission.dispatchState === 'rejected'
  )
  const details = input.launchDetails
  return (
    (input.unavailable?.reason === 'notSignedIn' ? input.unavailable.account : undefined) ??
    (typeof details === 'object' && details !== null && 'account' in details
      ? accountKind(details.account)
      : undefined) ??
    signedOut(input.startFailures.findLast((fact) => fact.kind === 'notSignedIn')) ??
    signedOut(readAgentSessionFailureFact(latestRejection?.rejection)) ??
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
