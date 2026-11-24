import { z } from 'zod'

const APP_STAR_SOURCE_VALUES = [
  'star_nag',
  'agent_value_moment',
  'onboarding_completed',
  'settings',
  'landing'
] as const

// Main validates untrusted renderer sources against this closed enum before attaching star telemetry.
export const appStarSourceSchema = z.enum(APP_STAR_SOURCE_VALUES)
export type AppStarSource = z.infer<typeof appStarSourceSchema>
