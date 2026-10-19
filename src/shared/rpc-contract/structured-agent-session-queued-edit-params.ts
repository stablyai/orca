import { z } from 'zod'
import { Identifier, SessionId } from './structured-agent-session-identifiers'
import { MutationEnvelope, MAX_PROMPT_BYTES } from './structured-agent-session-params'

export const QueuedMessageUpdateParams = z
  .object({
    envelope: MutationEnvelope,
    messageId: Identifier('Invalid queued message id'),
    expectedBodyFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    text: z.string().refine((text) => new TextEncoder().encode(text).length <= MAX_PROMPT_BYTES)
  })
  .strict()

const QueuedMessageEditIdentity = z.object({
  sessionId: SessionId,
  messageId: Identifier('Invalid queued message id'),
  editId: Identifier('Invalid edit id')
})

export const QueuedMessageEditHoldParams = z.discriminatedUnion('action', [
  QueuedMessageEditIdentity.extend({
    action: z.literal('acquire'),
    expectedBodyFingerprint: z.string().regex(/^[0-9a-f]{64}$/)
  }).strict(),
  QueuedMessageEditIdentity.extend({ action: z.literal('renew') }).strict(),
  QueuedMessageEditIdentity.extend({ action: z.literal('release') }).strict()
])
