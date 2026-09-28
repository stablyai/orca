import { z } from 'zod'

export const SshTarget = z.object({
  targetId: z.string().min(1)
})

// Why optional: absent is a user's Connect, which is what every released client means by it.
export const SshConnect = SshTarget.extend({
  background: z.boolean().optional()
})
