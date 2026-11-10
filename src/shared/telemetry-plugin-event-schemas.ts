import { z } from 'zod'
import { isQualifiedPluginKey } from './plugins/frames/plugin-tab-key'

// Why only these two: both catalogs are public, so a key from them names nothing private.
// Private catalogs, git URLs, local folders and dev plugins never report.
export const PLUGIN_TELEMETRY_CATALOGS = ['official', 'community'] as const

/** `reinstall` is the same version again; totals count `install` only. */
export const PLUGIN_INSTALL_KINDS = ['install', 'update', 'reinstall'] as const

export const PLUGIN_INSTALL_TRIGGERS = ['catalog', 'deep_link', 'auto_update'] as const

const pluginKeySchema = z.string().max(129).refine(isQualifiedPluginKey)

export const pluginInstalledSchema = z
  .object({
    plugin_key: pluginKeySchema,
    version: z
      .string()
      .max(64)
      .regex(/^[0-9A-Za-z.+-]+$/),
    catalog: z.enum(PLUGIN_TELEMETRY_CATALOGS),
    kind: z.enum(PLUGIN_INSTALL_KINDS),
    trigger: z.enum(PLUGIN_INSTALL_TRIGGERS)
  })
  .strict()
