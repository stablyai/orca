import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../journal/agent-session-journal-types'
import '../journal/agent-session-journal-submission-schema'
import { SendParams } from '../../rpc-contract/structured-agent-session/structured-agent-session-params'
import {
  agentSessionSendBodyFingerprint,
  structuredAgentSessionMessageSendMutation
} from './structured-agent-session-send-mutation'

const BODY: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'You have 1 orchestration message.' }]
}

const ASKER: AgentJournalMessageItem['asker'] = {
  source: 'slack',
  userId: 'U0SAM',
  role: 'member',
  place: { kind: 'public_channel', id: 'C9' }
}

describe('a connector delivery mark', () => {
  it('travels with the message without changing its fingerprint', () => {
    const send = (body: AgentJournalMessageItem) =>
      structuredAgentSessionMessageSendMutation({
        sessionId: 'session-1',
        clientOperationId: 'op-1',
        expectedRuntimeFence: 1,
        body,
        delivery: 'queue-if-active'
      })
    // An echo of the same text must still match.
    const delivered = send({ ...BODY, origin: 'connector', asker: ASKER })
    expect(delivered.envelope.payloadFingerprint).toBe(send(BODY).envelope.payloadFingerprint)
    expect(
      agentSessionSendBodyFingerprint('session-1', { ...BODY, origin: 'connector', asker: ASKER })
    ).toBe(agentSessionSendBodyFingerprint('session-1', BODY))
    expect(delivered.body.origin).toBe('connector')
    expect(delivered.body.asker).toEqual(ASKER)
  })

  it('is refused from a client, which cannot claim a connector origin or asker', () => {
    const params = (body: unknown) => ({
      envelope: {
        sessionId: 'session-1',
        clientOperationId: 'op-1',
        expectedRuntimeFence: 1,
        payloadFingerprint: 'a'.repeat(64)
      },
      body
    })
    expect(SendParams.safeParse(params(BODY)).success).toBe(true)
    expect(SendParams.safeParse(params({ ...BODY, origin: 'connector' })).success).toBe(false)
    expect(SendParams.safeParse(params({ ...BODY, asker: ASKER })).success).toBe(false)
  })
})
