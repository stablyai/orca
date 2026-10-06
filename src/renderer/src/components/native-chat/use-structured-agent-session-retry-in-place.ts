// A Retry of a message no agent ever took. A host that can queues that same message again, under its
// own id, so the chat never holds two copies and a second press from anywhere sends nothing more.
// A host known not to offers no such Retry: the host recorded the message, so sending it again is a
// new message. Until the host has said which, that Retry takes no press: a new copy sent then would
// leave the original with a live Retry once the host says it can.

import { useCallback, useMemo } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { AGENT_SESSION_RETRY_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { isRequeueableAgentJournalSubmission } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'

const NONE: ReadonlySet<string> = new Set()

export function useStructuredAgentSessionRetryInPlace(args: {
  target: RuntimeClientTarget
  mutate: StructuredAgentSessionMutate
  submissions: readonly AgentJournalSubmission[]
  /** The outbox's Retry, which sends this desktop's own message again as a new one. */
  outboxRetry: (clientMessageId: string) => void
}): {
  retry: (clientMessageId: string) => void
  /** Whether the host is known to queue a message again. */
  retriesInPlace: boolean
  /** Messages whose Retry depends on the host's answer, while it has not given one. */
  retryWaitsForHost: ReadonlySet<string>
} {
  const { mutate, outboxRetry, submissions } = args
  const capability = useStructuredAgentSessionHostCapabilityState(
    args.target,
    AGENT_SESSION_RETRY_MESSAGE_RUNTIME_CAPABILITY
  )
  const retryInPlace = useCallback(
    (clientMessageId: string) => {
      // The stream's `pending` moves the message back to sending; nothing is set here, or a snapshot
      // still showing it rejected would flip it straight back.
      void mutate('agentSession.retryMessage', 'agentSession.retryMessage', { clientMessageId })
    },
    [mutate]
  )
  const retryWaitsForHost = useMemo(
    () =>
      capability === 'unknown'
        ? new Set(
            submissions
              .filter(isRequeueableAgentJournalSubmission)
              .map((submission) => submission.clientMessageId)
          )
        : NONE,
    [capability, submissions]
  )
  const retry = (clientMessageId: string): void => {
    const submission = submissions.find((entry) => entry.clientMessageId === clientMessageId)
    if (!submission || !isRequeueableAgentJournalSubmission(submission)) {
      outboxRetry(clientMessageId)
    } else if (capability === 'supported') {
      retryInPlace(clientMessageId)
    } else if (capability === 'unsupported') {
      outboxRetry(clientMessageId)
    }
  }
  return {
    retry,
    retriesInPlace: capability === 'supported',
    retryWaitsForHost
  }
}
