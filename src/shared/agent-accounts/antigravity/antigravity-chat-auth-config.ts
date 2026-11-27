import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const AntigravityChatAuthConfigSchema = lazyZodSchema(() =>
  z.discriminatedUnion('method', [
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
)

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
      'Antigravity account settings are incomplete. Choose an account type and enter a Google Cloud project and location for Gemini Enterprise.'
    )
  }
  return parsed.data
}
