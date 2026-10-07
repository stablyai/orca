// What the answer to a send's one `agentSession.send` request proves about its message.

import type { AgentSessionMutationResult, AgentSessionSendResult } from './agent-session-wire'
import {
  agentSessionRefusalFailure,
  agentSessionRpcErrorFailure,
  readAgentSessionErrorRefusal,
  type AgentSessionWriteFailure
} from './agent-session-write-failure'

/** The reason a host gives a made-up `unknown` row: its ledger has the id and its journal does not,
 *  so the message may never have been written. */
export const STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING = 'durable_send_submission_missing'

export type StructuredAgentSessionSendAnswer =
  | { kind: 'result'; result: AgentSessionMutationResult<AgentSessionSendResult> }
  | { kind: 'thrown'; error: unknown; rpcCode: string | undefined }

export type StructuredAgentSessionSendEvidence =
  /** The host holds the message (a row in any state, or a queued card): it is the host's now. */
  | { kind: 'recorded' }
  /** The host holds nothing under this id and runs nothing for it: the text goes back. */
  | { kind: 'not-recorded'; failure: AgentSessionWriteFailure }
  /** An answer that proves nothing (a lost one included): it may already be in the chat. */
  | { kind: 'uncertain' }

// RPC codes a host answers before it runs the method: nothing under the id was written.
const TURNED_AWAY_RPC_CODES: ReadonlySet<string> = new Set([
  'method_not_found',
  'method_not_supported',
  'invalid_argument',
  'unauthorized'
])

/** What the answer to a send's one request proves. Nothing sends it again, so no answer is ever
 *  read against an earlier attempt. */
export function structuredAgentSessionSendEvidence(
  answer: StructuredAgentSessionSendAnswer
): StructuredAgentSessionSendEvidence {
  if (answer.kind === 'thrown') {
    // A thrown error, a thrown refusal included, is never proof: the host may have written first.
    return answer.rpcCode !== undefined &&
      TURNED_AWAY_RPC_CODES.has(answer.rpcCode) &&
      readAgentSessionErrorRefusal(answer.error) === undefined
      ? { kind: 'not-recorded', failure: agentSessionRpcErrorFailure(answer.rpcCode) }
      : { kind: 'uncertain' }
  }
  const { result } = answer
  if (result.ok) {
    const value: AgentSessionSendResult = result.value
    // A made-up row for an id the host's ledger holds and its journal lost.
    return 'submission' in value &&
      value.submission.reason === STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING
      ? { kind: 'uncertain' }
      : { kind: 'recorded' }
  }
  const failure = agentSessionRefusalFailure(result.refusal)
  // "Outcome unknown" is never proof; an unconfirmed rewind is the host saying the send never ran.
  if (failure.kind === 'refused' && failure.code === 'agent_session_operation_unknown') {
    return failure.details?.reason === 'rewindUnconfirmed'
      ? { kind: 'not-recorded', failure }
      : { kind: 'uncertain' }
  }
  // This request was the only one that carried the id, so nothing under it is recorded or running.
  return { kind: 'not-recorded', failure }
}
