import { z } from 'zod'

export const AntigravityChatAuthConfigSchema = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal('oauth-personal'),
    gcpProject: z.string().trim().max(255).optional(),
    gcpLocation: z.string().trim().max(255).optional()
  }),
  // Older Orca versions saved Gemini Enterprise apart; agy's own sign-in now picks it.
  z.strictObject({
    method: z.literal('oauth-business'),
    gcpProject: z.string().trim().max(255).optional(),
    gcpLocation: z.string().trim().max(255).optional()
  }),
  // A key saved in Settings, else GEMINI_API_KEY from the chat's launch environment.
  z.strictObject({
    method: z.literal('gemini-api-key'),
    gcpProject: z.string().trim().max(255).optional(),
    gcpLocation: z.string().trim().max(255).optional()
  }),
  // Google Agent Platform with the host's ADC; an empty project or location comes from gcloud.
  z.strictObject({
    method: z.literal('agent-platform'),
    gcpProject: z.string().trim().max(255).optional(),
    gcpLocation: z.string().trim().max(255).optional()
  })
])

export type AntigravityChatAuthConfig = z.infer<typeof AntigravityChatAuthConfigSchema>

export type AntigravityChatAuthSettings = { antigravityChatAuth?: AntigravityChatAuthConfig }

export class AntigravityChatAuthConfigError extends Error {}

/** The saved choice, with an older Gemini Enterprise one read as the Google sign-in it now is. */
export function resolveAntigravityChatAuthConfig(value: unknown): AntigravityChatAuthConfig {
  if (value === undefined) {
    return { method: 'oauth-personal' }
  }
  const parsed = AntigravityChatAuthConfigSchema.safeParse(value)
  if (!parsed.success) {
    throw new AntigravityChatAuthConfigError(
      'Antigravity account settings are incomplete. Choose how Antigravity signs in.'
    )
  }
  return parsed.data.method === 'oauth-business' ? { method: 'oauth-personal' } : parsed.data
}
