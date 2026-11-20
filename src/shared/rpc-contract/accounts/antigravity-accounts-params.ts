import { z } from 'zod'
import type { AntigravityChatAuthConfig } from '../../agent-accounts/antigravity/antigravity-chat-auth-config'

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

/** Credentials the host's Antigravity chat could use, as flags and labels; never a secret. */
export type AntigravityChatAuthDetection = {
  /** The saved sign-in method; null while it is malformed or being saved. */
  method: AntigravityChatAuthConfig['method'] | null
  /** Saved Google sign-ins of Orca's managed server, one per Google method. */
  googleSignIn: { personal: boolean; business: boolean }
  /** A pasted key wins over GEMINI_API_KEY, as the chat's launch does. */
  apiKey: { available: boolean; source: 'saved' | 'environment' | null }
  /** Application Default Credentials, with the project the chat would use. */
  adc: { available: boolean; project: string | null }
  /** Antigravity chats with a running child, which switching methods restarts. */
  liveChats: number
  /** The version of the host's agy that last passed Orca's check, else null. Absent from older hosts. */
  agyVersion?: string | null
}
