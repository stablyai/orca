import { z } from 'zod'
import { Identifier, SessionId } from './structured-agent-session-identifiers'
import { MutationEnvelope, MAX_BLOCKS, MAX_PROMPT_BYTES } from './structured-agent-session-params'
import { SendImageRefBlock } from './structured-agent-session-message-params'

const moveIdentity = {
  envelope: MutationEnvelope,
  messageId: Identifier('Invalid queued message id')
}
export const QueuedMessageMoveParams = z.union([
  z
    .object({ ...moveIdentity, beforeMessageId: Identifier('Invalid anchor id').nullable() })
    .strict(),
  z.object({ ...moveIdentity, afterMessageId: Identifier('Invalid anchor id') }).strict()
])

export const QueuedMessageUpdateParams = z
  .object({
    envelope: MutationEnvelope,
    messageId: Identifier('Invalid queued message id'),
    expectedBodyFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    text: z.string().refine((text) => new TextEncoder().encode(text).length <= MAX_PROMPT_BYTES),
    /** Complete ordered images with agent-session.queued-message-image-edit.v1; absent preserves images for old clients.
     * Shared edit bounds count images with the text block. */
    images: z.array(SendImageRefBlock).max(MAX_BLOCKS).optional()
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
