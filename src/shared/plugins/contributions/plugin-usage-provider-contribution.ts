import { z } from 'zod'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import { pluginIdSchema } from '../manifest/plugin-manifest-fields'
import { pluginFieldDoc } from '../manifest/plugin-schema-field-docs'

export const PLUGIN_USAGE_PROVIDERS_SINCE = '1.4.277'
export const PLUGIN_USAGE_PROVIDER_LIMIT = 8
export const PLUGIN_USAGE_PROVIDERS_CHANGED_CHANNEL = 'plugins:usageProvidersChanged'

export const pluginUsageProviderContributionSchema = z
  .strictObject({
    id: pluginIdSchema.meta(
      pluginFieldDoc('Provider id, unique within the plugin.', PLUGIN_USAGE_PROVIDERS_SINCE, [
        'sample-quota'
      ])
    ),
    label: safePluginDisplayText(z.string().max(64))
      .trim()
      .min(1)
      .meta(
        pluginFieldDoc('Label shown in the usage area.', PLUGIN_USAGE_PROVIDERS_SINCE, [
          'Sample quota'
        ])
      )
  })
  .meta({
    id: 'UsageProviderContribution',
    description: 'A quota source updated by its plugin worker.'
  })

export type PluginUsageProviderContribution = z.infer<typeof pluginUsageProviderContributionSchema>

const pluginUsageWindowSchema = z.strictObject({
  windowMinutes: z.number().int().min(1).max(527_040),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.number().int().min(0).max(8_640_000_000_000_000).nullish()
})

export const pluginUsageProviderUpdateSchema = z.strictObject({
  id: pluginIdSchema,
  windows: z
    .array(pluginUsageWindowSchema)
    .max(8)
    .refine(
      (windows) =>
        new Set(windows.map(({ windowMinutes }) => windowMinutes)).size === windows.length,
      'window durations must be unique'
    )
})

export type PluginUsageProviderUpdate = z.infer<typeof pluginUsageProviderUpdateSchema>

export type PluginUsageReading = {
  pluginKey: string
  pluginName?: string
  iconRevision?: string
  providerId: string
  label: string
  windows: { windowMinutes: number; usedPercent: number; resetsAt: number | null }[]
  observedAt: number
}
