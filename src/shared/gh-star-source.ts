import { z } from 'zod'

const APP_STAR_SOURCE_VALUES = [
  'star_nag',
  'agent_value_moment',
  'onboarding_completed',
  'settings',
  'landing'
] as const

// Why: renderer-originated IPC is untrusted, so main validates against this
// closed enum before attaching source context to successful star telemetry.
export const appStarSourceSchema = z.enum(APP_STAR_SOURCE_VALUES)
export type AppStarSource = z.infer<typeof appStarSourceSchema>
