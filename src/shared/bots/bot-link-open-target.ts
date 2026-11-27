import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { CONNECTOR_SOURCES } from '../connectors/external-conversation-link'

const Id = lazyZodSchema(() => z.string().min(1).max(128))

/** Guarded caller-only opening never follows a clear into a different session. */
export const BotLinkOpenTargetSchema = lazyZodSchema(() =>
  z
    .object({
      botId: Id,
      conversation: z.object({
        source: z.enum(CONNECTOR_SOURCES),
        externalId: z.string().min(1).max(512)
      }),
      leadSessionId: Id,
      sessionId: Id,
      worktreeId: z.string().min(1).max(256),
      itemId: Id.optional(),
      workerDispatchId: Id.optional()
    })
    .strict()
)

export type BotLinkOpenTarget = z.output<typeof BotLinkOpenTargetSchema>
