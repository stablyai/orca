import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

const failure = {
  kind: 'startFailed',
  refusal: { code: 'agent_session_operation_invalid', details: { ownerVerdict: 'exited' } }
} as const

function send(id: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: `orca:${id}`,
    revision: 0,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Hello' }] },
    turnScope: { kind: 'thread' }
  }
}

function startFailureRow(id: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: `orca:start-failure%3A${id}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'status', text: "Claude couldn't start.", tone: 'error' },
    turnScope: { kind: 'thread' }
  }
}

function rejected(id: string, submittedAt: number, resolvedAt: number): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: 'same-text',
    dispatchState: 'rejected',
    providerItemId: null,
    reason: "Claude couldn't start.",
    rejection: failure,
    submittedAt,
    resolvedAt,
    acceptedSequence: submittedAt
  }
}

describe('a message resent after its agent could not start', () => {
  it('shows one copy and only the resend’s start failure', () => {
    const messages = projectStructuredAgentSessionMessages(
      [
        send('first', 2),
        startFailureRow('first', 3),
        send('again', 5),
        startFailureRow('again', 6)
      ],
      [],
      [rejected('first', 1, 3), rejected('again', 4, 6)]
    )

    expect(messages.map((message) => message.id)).toEqual([
      'orca:again',
      'orca:start-failure%3Aagain'
    ])
  })
})
