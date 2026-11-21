import * as z from 'zod'
import { JournalCursor, SessionId } from './structured-agent-session-identifiers'

// Not strict: this host drops keys a newer client adds; a new value for a known key still needs a capability.
const SubscribeCapabilities = z.object({
  textAppend: z.literal(1).optional(),
  toolOutputAppend: z.literal(1).optional(),
  // This reader shows suggestions on screen; the host pauses generating them while none does.
  promptSuggestions: z.literal(1).optional(),
  // This reader takes live text only while it says it is shown (`shown`, then `agentSession.liveTextShown`).
  liveTextViewer: z.literal(1).optional()
})

export const SubscribeParams = z
  .object({
    sessionId: SessionId,
    cursor: JournalCursor.optional(),
    capabilities: SubscribeCapabilities.optional(),
    // Whether a `liveTextViewer` reader is shown as it subscribes.
    shown: z.boolean().optional()
  })
  .strict()

/** A live-text viewer saying it is shown or hidden: one connection's view of one chat. */
export const LiveTextShownParams = z
  .object({
    sessionId: SessionId,
    shown: z.boolean()
  })
  .strict()
