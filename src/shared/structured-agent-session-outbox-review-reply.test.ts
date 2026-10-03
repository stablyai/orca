import { describe, expect, it } from 'vitest'
import type { AgentSessionReviewReply } from './agent-session-review-reply'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'
import {
  createStructuredAgentSessionOutboxEntry,
  parseStructuredAgentSessionOutboxEntry,
  requeueStructuredAgentSessionSendRefusal,
  structuredAgentSessionSendMutation,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'

const REVIEW_REPLY: AgentSessionReviewReply = {
  provider: 'github',
  repoId: 'repo-1',
  prNumber: 42,
  resolve: ['thread-1'],
  replies: [{ commentId: 7, threadId: 'thread-7' }],
  replyBody: 'Fixing. Will be in the next commit'
}

function launchPrompt(): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: '1800000000000-00000000000000000000000000000001',
      sessionId: 'session-1',
      text: 'Resolve these',
      attachments: [],
      queuedAt: 1
    }),
    source: 'launch',
    reviewReply: REVIEW_REPLY
  }
}

describe("a launch prompt's review reply on the outbox", () => {
  it('survives the stored copy, and a malformed one is dropped, never the message', () => {
    const stored: unknown = JSON.parse(JSON.stringify(launchPrompt()))
    expect(parseStructuredAgentSessionOutboxEntry(stored, 'session-1')).toMatchObject({
      reviewReply: REVIEW_REPLY
    })
    const malformed: unknown = { ...launchPrompt(), reviewReply: { provider: 'github' } }
    const parsed = parseStructuredAgentSessionOutboxEntry(malformed, 'session-1')
    expect(parsed).not.toBeNull()
    expect(parsed).not.toHaveProperty('reviewReply')
  })

  it('rides every send of the entry, in the fingerprint the host digests', () => {
    const mutation = structuredAgentSessionSendMutation(launchPrompt(), 2)
    expect(mutation.reviewReply).toEqual(REVIEW_REPLY)
    expect(mutation.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body: mutation.body, reviewReply: REVIEW_REPLY }
      })
    )
  })

  it('stays on the entry when a refused send goes out again under a new id', () => {
    const requeued = requeueStructuredAgentSessionSendRefusal(
      launchPrompt(),
      { kind: 'refused', code: 'agent_session_operation_expired' },
      () => '1800000000000-00000000000000000000000000000002'
    )
    expect(requeued).toMatchObject({
      clientMessageId: '1800000000000-00000000000000000000000000000002',
      reviewReply: REVIEW_REPLY
    })
  })
})
