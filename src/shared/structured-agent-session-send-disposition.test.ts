// What a rejection puts on the user's screen.
//
// The module is pure so this can be asserted directly instead of through the hook,
// which is the whole reason it was split out.

import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionMutationResult, AgentSessionSendResult } from './agent-session-wire'
import { dispatchWriteFailureReason } from './structured-agent-session-dispatch-rejection'
import { disposeStructuredAgentSessionSendResult } from './structured-agent-session-send-disposition'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'

const entry: StructuredAgentSessionOutboxEntry = createStructuredAgentSessionOutboxEntry({
  clientMessageId: 'client-1',
  sessionId: 'session-1',
  text: 'hello',
  attachments: [],
  queuedAt: 1
})

function rejectedWith(reason: string | null): AgentSessionMutationResult<AgentSessionSendResult> {
  const submission: AgentJournalSubmission = {
    clientMessageId: 'client-1',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'rejected',
    providerItemId: null,
    reason,
    submittedAt: 10,
    resolvedAt: 10
  }
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 10 },
    value: { clientMessageId: 'client-1', submission }
  } as AgentSessionMutationResult<AgentSessionSendResult>
}

function notice(reason: string | null): string | null {
  return disposeStructuredAgentSessionSendResult({
    entries: [entry],
    entry,
    blockedClientMessageId: null,
    result: rejectedWith(reason),
    createOperationId: () => 'unused'
  }).error
}

describe('what a rejection shows the user', () => {
  it('never puts the transport marker on screen', () => {
    const shown = notice(dispatchWriteFailureReason(new Error('broken pipe')))
    // `provider_write_failed: broken pipe` names nothing a person can act on.
    expect(shown).not.toContain('provider_write_failed')
    expect(shown).not.toContain('broken pipe')
    // And it says the message is safe to send again, which it is: the frame never left.
    expect(shown).toBe(
      "Couldn't reach the agent. Your message was not sent — Retry to send it again."
    )
  })

  it('shows a content rejection in the provider own words', () => {
    // The provider explaining itself IS the answer; a generic string throws it away.
    expect(notice('Claude messages support at most 20 images')).toBe(
      'Claude messages support at most 20 images'
    )
  })

  it('claims no cause when the rejection names none', () => {
    expect(notice(null)).toBe('Message was not sent.')
  })
})
