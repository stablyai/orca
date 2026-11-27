import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { JournalCursor, SessionId } from './structured-agent-session-identifiers'

// Not strict: this host drops keys a newer client adds; a new value for a known key still needs a capability.
const SubscribeCapabilities = lazyZodSchema(() =>
  z.object({
    textAppend: z.literal(1).optional(),
    toolOutputAppend: z.literal(1).optional(),
    // This reader shows suggestions on screen; the host pauses generating them while none does.
    promptSuggestions: z.literal(1).optional(),
    // This reader takes live text only while it says it is shown: now, then via `agentSession.liveTextShown`.
    liveTextViewer: z
      .object({
        id: z.string().min(16).max(64),
        shown: z.boolean(),
        // The viewer's report sequence, so a report older than this one is ignored.
        seq: z.number().int().nonnegative()
      })
      .optional()
  })
)

export const SubscribeParams = lazyZodSchema(() =>
  z
    .object({
      sessionId: SessionId,
      cursor: JournalCursor.optional(),
      capabilities: SubscribeCapabilities.optional()
    })
    .strict()
)

/** A live-text viewer saying it is shown or hidden: one connection's view of one chat. */
export const LiveTextShownParams = lazyZodSchema(() =>
  z
    .object({
      sessionId: SessionId,
      // The viewer's own id from its subscribe: random, and on whatever connection the call takes.
      viewerId: z.string().min(16).max(64),
      shown: z.boolean(),
      // Increases with each report from this viewer; an older one arriving late is ignored.
      seq: z.number().int().nonnegative()
    })
    .strict()
)
