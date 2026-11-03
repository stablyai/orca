import { describe, expect, it } from 'vitest'
import { QueuedMessageUpdateParams } from './structured-agent-session-queued-edit-params'
import { MAX_SKILL_REFS } from './structured-agent-session-message-params'
import { queuedMessageWithEdit } from '../queued-message-edit'

const request = {
  envelope: {
    sessionId: 'as_1234567890abcdef',
    clientOperationId: 'edit',
    expectedRuntimeFence: 1,
    payloadFingerprint: 'a'.repeat(64)
  },
  messageId: 'queued',
  expectedBodyFingerprint: 'b'.repeat(64),
  text: '$review this'
}
describe('optional queued edit skills contract', () => {
  it('accepts legacy omission, complete replacement and []; strict old hosts require capability-gated omission', () => {
    const oldHost = QueuedMessageUpdateParams.omit({ skills: true })
    for (const fields of [
      {},
      { skills: [] },
      { skills: [{ name: 'review', path: '/remote/SKILL.md' }] }
    ]) {
      expect(QueuedMessageUpdateParams.safeParse({ ...request, ...fields }).success).toBe(true)
      expect(oldHost.safeParse({ ...request, ...fields }).success).toBe(!('skills' in fields))
    }
    expect(
      QueuedMessageUpdateParams.safeParse({
        ...request,
        skills: Array.from({ length: MAX_SKILL_REFS + 1 }, () => ({
          name: 'review',
          path: '/remote/SKILL.md'
        }))
      }).success
    ).toBe(false)
  })
  it('filters refs by the existing text policy and canonicalizes an empty replacement to absent', () => {
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: '$review this' }],
      skills: [{ name: 'review', path: '/old/SKILL.md' }]
    }
    expect(queuedMessageWithEdit(body, { text: '$review this', skills: [] })).toEqual({
      ok: true,
      body: { kind: 'message', role: 'user', blocks: body.blocks }
    })
    expect(
      queuedMessageWithEdit(body, {
        text: '$review that',
        skills: [
          { name: 'review', path: '/new/SKILL.md' },
          { name: 'missing', path: '/unused/SKILL.md' }
        ]
      })
    ).toMatchObject({ ok: true, body: { skills: [{ name: 'review', path: '/new/SKILL.md' }] } })
    expect(queuedMessageWithEdit(body, { text: '$review this' })).toEqual({ ok: true, body })
    expect(queuedMessageWithEdit(body, { text: 'plain legacy edit' })).toEqual({
      ok: true,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'plain legacy edit' }] }
    })
  })
})
