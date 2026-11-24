import * as z from 'zod'

export const BotPostToThread = z.object({
  bot_id: z.string().min(1).max(128),
  delivery_id: z.string().min(1).max(300),
  correlation_id: z.string().min(1).max(128).optional(),
  text: z.string().min(1).max(16_384),
  wake: z.boolean().default(false)
})
