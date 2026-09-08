import { z } from 'zod'

export const NotificationPermissionPayloadSchema = z
  .object({ request: z.boolean().optional() })
  .strict()
export const NotificationPermissionResultSchema = z.object({
  granted: z.boolean(),
  status: z.string().max(64),
  canAskAgain: z.boolean(),
  authorizationReflectsUserChoice: z.boolean()
})
export const NotificationPreferencePayloadSchema = z
  .object({ enabled: z.boolean().optional() })
  .strict()
export const NotificationPreferenceResultSchema = z.object({ enabled: z.boolean() })
export const OpenSystemSettingsPayloadSchema = z.object({}).strict()
export const OpenSystemSettingsResultSchema = z.null()
