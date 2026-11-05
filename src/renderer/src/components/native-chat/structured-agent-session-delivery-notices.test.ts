import { describe, expect, it } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'

import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'

import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'

import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

const SENDING = 'Sending…'

function body(text: string): StructuredAgentSessionPendingSend['body'] {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function pending(
  clientMessageId: string,
  phase: StructuredAgentSessionPendingSend['phase']
): StructuredAgentSessionPendingSend {
  return {
    clientMessageId,
    sessionId: 'session-1',
    body: body(clientMessageId),
    previewUris: [],
    queuedAt: 1,
    phase,
    issued: true
  }
}

function row(
  clientMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState'],
  patch: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: dispatchState === 'pending' ? null : 1,
    ...patch
  }
}

function notices(args: {
  pending?: StructuredAgentSessionPendingSend[]
  submissions?: AgentJournalSubmission[]
  startFailures?: AgentSessionFailureFact[]
}) {
  return structuredAgentSessionDeliveryNotices({
    pending: args.pending ?? [],
    submissions: args.submissions ?? [],
    agentName: 'Claude',
    startFailures: args.startFailures ?? []
  })
}

function texts(map: ReturnType<typeof notices>): Record<string, string> {
  return Object.fromEntries(
    [...map].map(([id, notice]) => [id, notice.sending ? SENDING : notice.text])
  )
}

describe('the line under each of the chat own messages', () => {
  it('keeps sending through either reply/journal ordering until the host resolves it', () => {
    const sending = { [agentJournalSubmissionKey('a')]: SENDING }
    const echo = pending('a', 'sending')
    const recordedEcho = pending('a', 'recorded')
    const hostPending = row('a', 'pending')
    expect(texts(notices({ pending: [pending('a', 'unconfirmed')] }))).toEqual({})
    for (const input of [
      { pending: [echo] },
      { pending: [recordedEcho] },
      { pending: [recordedEcho], submissions: [hostPending] },
      { pending: [echo], submissions: [hostPending] },
      { submissions: [hostPending] }
    ]) {
      expect(texts(notices(input))).toEqual(sending)
    }
    for (const phase of ['sending', 'recorded'] as const) {
      for (const state of ['accepted', 'unknown'] as const) {
        expect(
          texts(notices({ pending: [pending('a', phase)], submissions: [row('a', state)] }))
        ).toEqual({})
      }
      expect(
        texts(
          notices({
            pending: [pending('a', phase)],
            submissions: [row('a', 'rejected', { reason: 'Not accepted' })]
          })
        )
      ).toEqual({ [agentJournalSubmissionKey('a')]: 'Not accepted' })
    }
  })

  it("keeps the CLI's own startup words behind the rejected message unless a start row has them", () => {
    const exited: AgentSessionFailureFact = {
      kind: 'providerStartFailed',
      detail: { text: '(code 1)\nclaude: unknown option --foo', audience: 'log' }
    }
    const submission = row('a', 'rejected', { reason: 'Written by the host.', rejection: exited })
    expect(notices({ submissions: [submission] }).get(agentJournalSubmissionKey('a'))).toEqual({
      text: 'Claude stopped before it finished starting. Send your message to try again.',
      detail: '(code 1)\nclaude: unknown option --foo'
    })
    expect(
      notices({ submissions: [submission], startFailures: [exited] }).get(
        agentJournalSubmissionKey('a')
      )?.detail
    ).toBeUndefined()
    // A refusal's sentence already quotes the provider's words.
    const rejected: AgentSessionFailureFact = {
      kind: 'providerRejected',
      detail: { text: 'Too long', audience: 'person' }
    }
    const refused = row('b', 'rejected', { rejection: rejected })
    expect(notices({ submissions: [refused] }).get(agentJournalSubmissionKey('b'))?.detail).toBe(
      undefined
    )
  })

  it('says nothing for a message a Stop withdrew: it went back to the composer', () => {
    expect(
      texts(notices({ submissions: [row('a', 'rejected', { rejection: { kind: 'cancelled' } })] }))
    ).toEqual({})
  })
})
