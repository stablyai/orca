// A bot's memory history: one row per change to its MEMORY.md, kept by Orca outside the bot's home.
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

/** How long a row is kept. */
export const BOT_MEMORY_HISTORY_DAYS = 90

const BotMemoryLineSchema = lazyZodSchema(() =>
  z.object({ line: z.string(), after: z.string().nullable() })
)

export const BotMemoryAuthorSchema = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    /** A chat's turn wrote it; `source` is who outside spoke in that window, null the owner. */
    z.object({ kind: z.literal('chat'), sessionId: z.string(), source: z.string().nullable() }),
    /** Orca put back what a chat's write dropped. */
    z.object({ kind: z.literal('kept'), sessionId: z.string() }),
    /** The owner, in Settings. */
    z.object({ kind: z.literal('owner') }),
    /** The bot's own Forget command, from one of its chats. */
    z.object({ kind: z.literal('bot'), sessionId: z.string() }),
    /** An Undo of row `of`. */
    z.object({ kind: z.literal('undo'), of: z.string() }),
    /** The bot's nightly Tidy-up. */
    z.object({ kind: z.literal('tidy-up') })
  ])
)

export type BotMemoryAuthor = z.infer<typeof BotMemoryAuthorSchema>

export const BotMemoryHistoryRowSchema = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    at: z.number(),
    by: BotMemoryAuthorSchema,
    change: z.object({
      added: z.array(BotMemoryLineSchema),
      removed: z.array(BotMemoryLineSchema)
    }),
    /** False when a line held something secret-looking: the row keeps it redacted, so Undo would
     *  write the redaction. */
    undoable: z.boolean()
  })
)

export type BotMemoryHistoryRow = z.infer<typeof BotMemoryHistoryRowSchema>

/** A row as Settings shows it, with the chat it came from named. */
export type BotMemoryHistoryView = BotMemoryHistoryRow & { chat: string | null }
