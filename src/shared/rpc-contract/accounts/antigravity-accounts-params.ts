import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import type { AntigravityChatAuthConfig } from '../../agent-accounts/antigravity/antigravity-chat-auth-config'

export const AntigravityAccountTargetParams = lazyZodSchema(() =>
  z
    .object({
      runtime: z.enum(['host', 'wsl']),
      wslDistro: z.string().min(1).max(255).nullable().optional()
    })
    .strict()
)

export const AntigravityAccountMutationParams = lazyZodSchema(() =>
  z
    .object({
      target: AntigravityAccountTargetParams,
      accountId: z.string().min(1).max(128)
    })
    .strict()
)

export const AntigravityAccountSelectParams = lazyZodSchema(() =>
  z
    .object({
      target: AntigravityAccountTargetParams,
      accountId: z.string().min(1).max(128),
      // The switching window restarts its own terminals; the host only lists them.
      movesRunningSessions: z.literal(true).optional(),
      // The switching client's choice for the host's running terminals.
      runningSessions: z.enum(['ask', 'restart', 'keep']).optional(),
      // Answers the Ask an earlier switch to this account left open; never switches accounts itself.
      answersAsk: z.literal(true).optional()
    })
    .strict()
)

export const AntigravityUnheldTerminalsParams = lazyZodSchema(() =>
  z
    .object({
      previousAccountId: z.string().min(1).max(128).nullable(),
      accountId: z.string().min(1).max(128),
      ptyIds: z.array(z.string().min(1).max(512)).max(4096),
      runningSessions: z.enum(['ask', 'restart', 'keep'])
    })
    .strict()
)

export const AntigravityChatSignInStartParams = lazyZodSchema(() =>
  z.strictObject({
    intent: z.enum(['signIn', 'changeAccount']).optional()
  })
)

export const AntigravityChatSignInFlowParams = lazyZodSchema(() =>
  z.strictObject({
    flowId: z.string().min(1).max(64)
  })
)

export const AntigravityChatSignInCompleteParams = lazyZodSchema(() =>
  z.strictObject({
    flowId: z.string().min(1).max(64),
    callbackUrl: z.string().min(1).max(16_384)
  })
)

export const AntigravityChatApiKeySaveParams = lazyZodSchema(() =>
  z.strictObject({
    apiKey: z.string().trim().min(1).max(512)
  })
)

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
  /** New chats here run on agy, which is definitely not signed in. Absent from older hosts. */
  agySignedOut?: boolean
}
