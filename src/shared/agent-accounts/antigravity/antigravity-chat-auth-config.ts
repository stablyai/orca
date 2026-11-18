import { z } from 'zod'

export const AntigravityChatAuthConfigSchema = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal('oauth-personal'),
    gcpProject: z.string().trim().max(255).optional(),
    gcpLocation: z.string().trim().max(255).optional()
  }),
  z.strictObject({
    method: z.literal('oauth-business'),
    gcpProject: z.string().trim().min(1).max(255),
    gcpLocation: z.string().trim().min(1).max(255)
  }),
  // The server reads GEMINI_API_KEY from the chat's launch environment.
  z.strictObject({
    method: z.literal('gemini-api-key'),
    gcpProject: z.string().trim().max(255).optional(),
    gcpLocation: z.string().trim().max(255).optional()
  }),
  // Gemini Enterprise Agent Platform with the host's Application Default Credentials.
  z.strictObject({
    method: z.literal('agent-platform'),
    gcpProject: z.string().trim().min(1).max(255),
    gcpLocation: z.string().trim().min(1).max(255)
  })
])

/** Methods whose server reads a Google Cloud project and location from its settings. */
export function antigravityChatAuthUsesGcp(
  config: AntigravityChatAuthConfig
): config is Extract<AntigravityChatAuthConfig, { method: 'oauth-business' | 'agent-platform' }> {
  return config.method === 'oauth-business' || config.method === 'agent-platform'
}

export type AntigravityChatAuthConfig = z.infer<typeof AntigravityChatAuthConfigSchema>

export type AntigravityChatAuthSettings = { antigravityChatAuth?: AntigravityChatAuthConfig }

export class AntigravityChatAuthConfigError extends Error {}

export function resolveAntigravityChatAuthConfig(value: unknown): AntigravityChatAuthConfig {
  if (value === undefined) {
    return { method: 'oauth-personal' }
  }
  const parsed = AntigravityChatAuthConfigSchema.safeParse(value)
  if (!parsed.success) {
    throw new AntigravityChatAuthConfigError(
      'Antigravity account settings are incomplete. Choose an account type and enter a Google Cloud project and location for Gemini Enterprise or Agent Platform.'
    )
  }
  return parsed.data
}
