import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from './agent-session-journal-types'
import type { AgentMessageSource } from './agent-session-message-source'
import { SendParams } from './rpc-contract/structured-agent-session-params'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'
import {
  agentSessionSendBodyFingerprint,
  structuredAgentSessionMessageSendMutation
} from './structured-agent-session-send-mutation'

const BODY: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'You have 1 orchestration message.' }]
}

const FROM: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'term_peer', terminalHandle: 'term_peer', orcaSessionId: null },
      name: 'Claude'
    }
  ],
  orchestration: { message: 'mail-notice', mailbox: 'run:r1', dispatchId: null, messages: [] }
}

describe('send fingerprints never cover the sender', () => {
  it('keeps the digest every stored submission and draft already holds', () => {
    // Pinned bytes: a stored fingerprint that changed would stop matching its provider echo.
    expect(agentSessionSendBodyFingerprint('session-1', BODY)).toBe(
      'bf73e28368c0837ade16328692116535c6d97fc9924c70aa342a3cf18817d047'
    )
    expect(agentSessionSendBodyFingerprint('session-1', BODY)).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body: BODY }
      })
    )
  })

  it('fingerprints a body with a sender exactly as the same body without one', () => {
    expect(agentSessionSendBodyFingerprint('session-1', { ...BODY, from: FROM })).toBe(
      agentSessionSendBodyFingerprint('session-1', BODY)
    )
    const send = (body: AgentJournalMessageItem) =>
      structuredAgentSessionMessageSendMutation({
        sessionId: 'session-1',
        clientOperationId: 'op-1',
        expectedRuntimeFence: 1,
        body,
        delivery: 'queue-if-active'
      })
    const withSender = send({ ...BODY, from: FROM })
    expect(withSender.envelope.payloadFingerprint).toBe(send(BODY).envelope.payloadFingerprint)
    // The sender still travels with the message itself.
    expect(withSender.body.from).toEqual(FROM)
  })

  it('refuses a client send whose body names a sender', () => {
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
    expect(SendParams.safeParse(params({ ...BODY, from: FROM })).success).toBe(false)
  })
})
