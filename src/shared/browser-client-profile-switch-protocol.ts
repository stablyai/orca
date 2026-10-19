import { z } from 'zod'

export const BROWSER_CLIENT_PROFILE_SWITCH_CAPABILITY = 'profile-switch-v1' as const

// Only display metadata crosses the boundary; the desktop derives its own scoped partition.
export const BrowserClientProfileMetadata = z.strictObject({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
  scope: z.enum(['default', 'isolated', 'imported'])
})
export type BrowserClientProfileMetadata = z.infer<typeof BrowserClientProfileMetadata>

export const BrowserClientProfileSwitchCommand = z.object({
  type: z.literal('switchProfile'),
  profile: BrowserClientProfileMetadata,
  nextPageHostGeneration: z.number().int().min(1).max(0xffff_ffff)
})
