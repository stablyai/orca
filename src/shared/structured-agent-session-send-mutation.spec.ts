import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from './agent-session-journal-types'
import type { AgentMessageSource } from './agent-session-message-source'
import { AgentJournalSubmissionSchema } from './agent-session-journal-submission-schema'
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
  it('fingerprints message choices with the operation, never the body', () => {
    const send = (options?: { model: string; effort: string }) =>
      structuredAgentSessionMessageSendMutation({
        sessionId: 'session-1',
        clientOperationId: 'op-1',
        expectedRuntimeFence: 1,
        body: BODY,
        ...(options ? { options } : {})
      })
    const legacy = send()
    const chosen = send({ model: 'model-a', effort: 'high' })
    expect(chosen.envelope.payloadFingerprint).not.toBe(legacy.envelope.payloadFingerprint)
    expect(chosen.options).toEqual({ model: 'model-a', effort: 'high' })
    expect(SendParams.safeParse(legacy).success).toBe(true)
    expect(SendParams.safeParse(chosen).success).toBe(true)
  })

  it('reads a saved submission’s choices, ignoring keys an older build stored', () => {
    const submission = {
      clientMessageId: 'message-1',
      options: { model: 'model-a', unknownChoice: 'kept-by-an-older-build' },
      fence: 1,
      payloadFingerprint: 'a'.repeat(64),
      dispatchState: 'accepted',
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: 2
    }
    expect(AgentJournalSubmissionSchema.parse(submission).options).toEqual({ model: 'model-a' })
    expect(
      AgentJournalSubmissionSchema.omit({ options: true }).parse(submission)
    ).not.toHaveProperty('options')
  })

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

  it('carries options in the operation fingerprint only; without them the send is unchanged', () => {
    const send = (options?: Record<string, string>) =>
      structuredAgentSessionMessageSendMutation({
        sessionId: 'session-1',
        clientOperationId: 'op-1',
        expectedRuntimeFence: 1,
        body: BODY,
        ...(options ? { options } : {})
      })
    const plain = send()
    // An older host gets exactly today's shape and fingerprint.
    expect(plain).not.toHaveProperty('options')
    expect(plain.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body: BODY }
      })
    )
    const carried = send({ model: 'opus', effort: 'high' })
    expect(carried.options).toEqual({ model: 'opus', effort: 'high' })
    expect(carried.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body: BODY, options: { model: 'opus', effort: 'high' } }
      })
    )
    expect(SendParams.safeParse({ ...carried, body: BODY }).success).toBe(true)
  })

  it('binds source controls only into the operation hash while preserving the legacy payload', () => {
    const input = {
      sessionId: 'session-1',
      clientOperationId: 'op-1',
      expectedRuntimeFence: 1,
      body: BODY
    }
    const legacy = structuredAgentSessionMessageSendMutation(input)
    const bound = structuredAgentSessionMessageSendMutation({
      ...input,
      usageLimitContinuationOfTurnItemId: 'turn-1'
    })
    expect(legacy).not.toHaveProperty('usageLimitContinuationOfTurnItemId')
    expect(legacy.envelope.payloadFingerprint).not.toBe(bound.envelope.payloadFingerprint)
    expect(agentSessionSendBodyFingerprint('session-1', bound.body)).toBe(
      legacy.envelope.payloadFingerprint
    )
    expect(SendParams.safeParse(bound).success).toBe(true)
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
