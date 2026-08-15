import { z } from 'zod'
import { PORTABLE_SETTINGS_CATEGORIES } from './portable-settings-schema'

export const PORTABLE_SETTINGS_SYNC_VERSION = 1 as const

export const PortableSettingsSyncRuleSchema = z
  .object({
    environmentId: z.string().min(1).max(256),
    categories: z.array(z.enum(PORTABLE_SETTINGS_CATEGORIES)).min(1).max(3),
    enabled: z.boolean(),
    lastSyncedHash: z.string().max(128).nullable(),
    lastSyncedAt: z.number().finite().nullable()
  })
  .strict()

export const PortableSettingsSyncStoreSchema = z
  .object({
    version: z.literal(PORTABLE_SETTINGS_SYNC_VERSION),
    rules: z.array(PortableSettingsSyncRuleSchema).max(100)
  })
  .strict()

export type PortableSettingsSyncRule = z.infer<typeof PortableSettingsSyncRuleSchema>

export type PortableSettingsSyncPhase = 'paused' | 'pending' | 'syncing' | 'synced' | 'error'

export type PortableSettingsSyncState = PortableSettingsSyncRule & {
  phase: PortableSettingsSyncPhase
  lastError: string | null
}

export const PortableSettingsSyncConfigureArgsSchema = z
  .object({
    environmentId: z.string().min(1).max(256),
    categories: z.array(z.enum(PORTABLE_SETTINGS_CATEGORIES)).min(1).max(3),
    enabled: z.boolean()
  })
  .strict()

export type PortableSettingsSyncConfigureArgs = z.infer<
  typeof PortableSettingsSyncConfigureArgsSchema
>
