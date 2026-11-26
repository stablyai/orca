import * as z from 'zod'

export const NativeChatSignIn = z.object({
  agent: z.string().min(1).max(128),
  account: z.enum(['system', 'managed']).optional(),
  remote: z.boolean()
})
