import { z } from 'zod'

export const AntigravityAccountTargetParams = z
  .object({
    runtime: z.enum(['host', 'wsl']),
    wslDistro: z.string().min(1).max(255).nullable().optional()
  })
  .strict()

export const AntigravityAccountMutationParams = z
  .object({
    target: AntigravityAccountTargetParams,
    accountId: z.string().min(1).max(128)
  })
  .strict()

export const AntigravityChatSignInFlowParams = z.strictObject({
  flowId: z.string().min(1).max(64)
})

export const AntigravityChatSignInCompleteParams = z.strictObject({
  flowId: z.string().min(1).max(64),
  callbackUrl: z.string().min(1).max(16_384)
})
