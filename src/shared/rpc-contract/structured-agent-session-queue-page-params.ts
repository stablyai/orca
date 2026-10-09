import { z } from 'zod'
import { Identifier, SessionId } from './structured-agent-session-identifiers'
import { AGENT_SESSION_QUEUE_SOURCES } from '../agent-session-queue-pages'

export const QueuedMessagesPageParams = z
  .strictObject({
    sessionId: SessionId,
    source: z.enum(AGENT_SESSION_QUEUE_SOURCES).optional(),
    cursor: z
      .string()
      .min(1)
      .max(16 * 1024)
      .optional(),
    aroundMessageId: Identifier('Invalid queued message id').optional(),
    size: z.number().int().positive().optional()
  })
  .refine((value) => !(value.cursor && value.aroundMessageId), 'Choose a cursor or an anchor')

export const QueuedMessageReadParams = z.strictObject({
  sessionId: SessionId,
  messageId: Identifier('Invalid queued message id'),
  expectedState: z.enum(['waiting', 'returned']).optional(),
  cursor: z
    .string()
    .min(1)
    .max(16 * 1024)
    .optional()
})
