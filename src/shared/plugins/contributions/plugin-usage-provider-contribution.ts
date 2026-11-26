import { z } from 'zod'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import { pluginIdSchema } from '../manifest/plugin-manifest-fields'
import { pluginFieldDoc } from '../manifest/plugin-schema-field-docs'

export const PLUGIN_USAGE_PROVIDERS_SINCE = '1.4.278'
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

const usageLabel = safePluginDisplayText(z.string().max(64)).trim().min(1)
const pluginUsageWindowSchema = z.strictObject({
  label: usageLabel,
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.number().int().min(0).max(8_640_000_000_000_000).optional()
})

const pluginUsageAccountSchema = z.strictObject({
  label: usageLabel,
  plan: usageLabel.optional(),
  windows: z
    .array(pluginUsageWindowSchema)
    .max(8)
    .refine(
      (windows) => new Set(windows.map(({ label }) => label)).size === windows.length,
      'window labels must be unique within an account'
    )
})

export const pluginUsageProviderUpdateSchema = z.strictObject({
  id: pluginIdSchema,
  status: z.enum(['idle', 'fetching', 'ok', 'error', 'unavailable']),
  accounts: z
    .array(pluginUsageAccountSchema)
    .max(8)
    .refine(
      (accounts) => new Set(accounts.map(({ label }) => label)).size === accounts.length,
      'account labels must be unique within a provider'
    )
    .refine(
      (accounts) => accounts.reduce((count, { windows }) => count + windows.length, 0) <= 8,
      'a provider can publish at most eight windows'
    ),
  error: safePluginDisplayText(z.string().max(256)).trim().min(1).optional()
})

export type PluginUsageProviderUpdate = z.infer<typeof pluginUsageProviderUpdateSchema>

export type PluginUsageReading = Omit<PluginUsageProviderUpdate, 'id'> & {
  pluginKey: string
  pluginName?: string
  iconRevision?: string
  providerId: string
  label: string
  observedAt: number
}
