import { z } from 'zod'

export const MAX_STRUCTURED_CHAT_OPTION_LABEL = 512

/** Explicit choices are bounded like options accepted by the session picker. */
export const StructuredChatLaunchOptions = z
  .object({
    model: z.string().min(1).max(MAX_STRUCTURED_CHAT_OPTION_LABEL).optional(),
    effort: z.string().min(1).max(MAX_STRUCTURED_CHAT_OPTION_LABEL).optional(),
    fastMode: z.enum(['true', 'false']).optional(),
    permissionMode: z.enum(['ask', 'accept-edits', 'auto', 'bypass']).optional()
  })
  .strict()
