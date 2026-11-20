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

export const AntigravityChatSignInStartParams = z.strictObject({
  intent: z.enum(['signIn', 'changeAccount']).optional()
})

export const AntigravityChatSignInFlowParams = z.strictObject({
  flowId: z.string().min(1).max(64)
})

export const AntigravityChatSignInCompleteParams = z.strictObject({
  flowId: z.string().min(1).max(64),
  callbackUrl: z.string().min(1).max(16_384)
})

export const AntigravityChatApiKeySaveParams = z.strictObject({
  apiKey: z.string().trim().min(1).max(512)
})

/** Where the chat's Gemini API key comes from; neither ever carries the key itself. */
export type AntigravityChatApiKeyStatus = { saved: boolean; inEnvironment: boolean }
