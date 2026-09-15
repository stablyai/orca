import { z } from 'zod'

export const SshTarget = z.object({
  targetId: z.string().min(1)
})
