import { z } from 'zod'

export const APP_STAR_SOURCE_VALUES = ['star_nag', 'settings', 'landing'] as const

// Why: renderer-originated IPC is untrusted, so main validates against this
// closed enum before attaching source context to successful star telemetry.
export const appStarSourceSchema = z.enum(APP_STAR_SOURCE_VALUES)
export type AppStarSource = z.infer<typeof appStarSourceSchema>
