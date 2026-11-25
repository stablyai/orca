import * as z from 'zod'
import { JournalCursor, SessionId } from './structured-agent-session-identifiers'

// Not strict: this host drops keys a newer client adds; a new value for a known key still needs a capability.
const SubscribeCapabilities = z.object({
  providerReceipts: z.literal(1).optional(),
  textAppend: z.literal(1).optional(),
  toolOutputAppend: z.literal(1).optional(),
  // This reader shows suggestions on screen; the host pauses generating them while none does.
  promptSuggestions: z.literal(1).optional()
})

export const SubscribeParams = z
  .object({
    sessionId: SessionId,
    cursor: JournalCursor.optional(),
    capabilities: SubscribeCapabilities.optional()
  })
  .strict()

export const AckProviderReceiptsParams = z
  .object({
    subscription: z.uuid(),
    revision: z.number().int().nonnegative()
  })
  .strict()
