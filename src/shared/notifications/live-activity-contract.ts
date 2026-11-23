import * as z from 'zod'

export const LiveActivityRegistrationParams = z
  .object({
    activityId: z.string().min(1).max(128),
    token: z
      .string()
      .min(2)
      .max(4096)
      .regex(/^(?:[a-f0-9]{2})+$/i),
    apnsEnvironment: z.enum(['sandbox', 'production']),
    worktreeId: z.string().min(1).max(2048),
    paneKey: z.string().min(1).max(2048),
    showNames: z.boolean()
  })
  .strict()

export const LiveActivityRemovalParams = z
  .object({
    activityId: z.string().min(1).max(128)
  })
  .strict()

export type LiveActivityRegistration = z.infer<typeof LiveActivityRegistrationParams>

export const SavedLiveActivitySchema = LiveActivityRegistrationParams.extend({
  expiresAt: z.number().int().positive(),
  credentialRevision: z.number().int().nonnegative()
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
export type LiveActivityContent = {
  state: 'working' | 'attention' | 'done' | 'failed' | 'unavailable'
  title: string
  stateStartedAt: number
  updatedAt: number
}

export type LiveActivityPush = {
  token: string
  apnsEnvironment: 'sandbox' | 'production'
  timestamp: number
  event: 'update' | 'end'
  content: LiveActivityContent
}
