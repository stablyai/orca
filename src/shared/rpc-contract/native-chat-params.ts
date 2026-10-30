import { z } from 'zod'
import type { AgentType } from '../native-chat-types'

// Expose the same transcript readers over RPC for paired mobile/web native chat.

export const NativeChatSession = z.object({
  agent: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing agent'))
    .transform((v) => v as AgentType),
  sessionId: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing session id')),
  // Clamp history windows so paging past the cap stops cleanly instead of failing “load earlier”.
  limit: z
    .number()
    .int()
    .positive()
    .transform((value) => Math.min(value, MOBILE_NATIVE_CHAT_MAX_WINDOW))
    .optional(),
  // Use the same cleanup token for registration/unsubscribe; absent retains legacy agent:sessionId keys.
  subscriptionId: z.string().min(1).optional(),
  // Hook transcript paths locate files when provider session IDs no longer name them; optional for old clients.
  transcriptPath: z.string().min(1).optional(),
  // Gate pending snapshots: legacy clients mistake them for settled empty history and overwrite retention/unblock drafts.
  capabilities: z
    .object({
      transcriptPending: z.literal(1).optional(),
      transcriptSourceOrder: z.literal(1).optional()
    })
    .optional(),
  beforeOffset: z.number().int().nonnegative().optional()
})

export const NativeChatUnsubscribe = z.object({
  subscriptionId: z.string().min(1).optional()
})

export const MOBILE_NATIVE_CHAT_MAX_WINDOW = 2000
