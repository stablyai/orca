import { z } from 'zod'

export const CloudBeginSignInParams = z.object({
  /** Shown in Slack and on the approval page; defaults to the OS host name. */
  name: z.string().trim().min(1, 'Missing machine name').max(100).optional()
})

export const CloudFinishSignInParams = z.object({
  flowId: z.string().min(1, 'Missing sign-in id')
})
