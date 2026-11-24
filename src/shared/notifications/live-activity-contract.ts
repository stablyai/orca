import * as z from 'zod'

export const LiveActivityRegistrationParams = z
  .object({
    activityId: z.string().min(1).max(128),
    schemaVersion: z.literal(2),
    overviewId: z.uuid(),
    scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
    bootstrap: z
      .object({
        revision: z.number().int().positive(),
        showNames: z.boolean(),
        discoveryComplete: z.boolean(),
        controlKey: z.string().regex(/^[a-f0-9]{64}$/),
        token: z
          .string()
          .min(2)
          .max(4096)
          .regex(/^(?:[a-f0-9]{2})+$/i),
        apnsEnvironment: z.enum(['sandbox', 'production']),
        scopes: z
          .array(z.string().regex(/^[a-f0-9]{64}$/))
          .min(1)
          .max(32)
      })
      .strict()
      .optional(),
    showNames: z.boolean()
  })
  .strict()

export const LiveActivityRemovalParams = z
  .object({
    activityId: z.string().min(1).max(128)
  })
  .strict()

export const LiveActivitySessionParams = LiveActivityRemovalParams.extend({
  sessionId: z.string().regex(/^[a-f0-9]{32}$/)
})

export type LiveActivityRegistration = z.infer<typeof LiveActivityRegistrationParams>

export const SavedLiveActivitySchema = LiveActivityRegistrationParams.extend({
  expiresAt: z.number().int().positive(),
  credentialRevision: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative().default(0)
})
export type SavedLiveActivity = z.infer<typeof SavedLiveActivitySchema>

export function readSavedLiveActivities(value: unknown): SavedLiveActivity[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.slice(0, 4).flatMap((item) => {
    const parsed = SavedLiveActivitySchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

// Swift Codable and the independent cloud push contract use seconds since the Unix epoch.
export type LiveActivityState = 'working' | 'attention' | 'done' | 'failed' | 'unavailable'
export type LiveActivitySessionContent = {
  state: LiveActivityState
  title: string
  stateStartedAt: number
  updatedAt: number
}

export type LiveActivityCounts = Record<LiveActivityState, number>
export type LiveActivitySession = {
  agent?: string
  id: string
  segment: string
  title: string
  state: LiveActivityState
  elapsedSeconds: number
}
export type LiveActivityHostContent = {
  counts: LiveActivityCounts
  sessions: LiveActivitySession[]
  complete: boolean
}
export type LiveActivityContent = LiveActivitySessionContent & {
  schemaVersion: 2
  counts: LiveActivityCounts
  sessions: (Omit<LiveActivitySession, 'elapsedSeconds'> & {
    scopeId: string
    stateStartedAt: number
  })[]
  knownSources: number
  totalSources: number
  complete: boolean
}

export type LiveActivityPush = {
  schemaVersion: 2
  overviewId: string
  scopeKey: string
  sequence: number
  event: 'update' | 'end'
  content: LiveActivityHostContent
}

export type LiveActivityBootstrap = {
  schemaVersion: 2
  overviewId: string
  controlKey: string
  revision: number
  showNames: boolean
  discoveryComplete: boolean
  token: string
  apnsEnvironment: 'sandbox' | 'production'
  scopes: string[]
}
