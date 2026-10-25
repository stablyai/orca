import { z } from 'zod'
import { isQualifiedPluginKey } from './plugin-manifest'

export const PLUGIN_KILL_LIST_ENTRY_LIMIT = 4_096
/** Publisher clocks and client clocks disagree by minutes, never by days. */
export const PLUGIN_KILL_LIST_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000

const advisoryUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => new URL(value).protocol === 'https:', 'advisory URL must use HTTPS')

export const pluginKillListEntrySchema = z.strictObject({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  reason: z.string().min(1).max(1_024),
  advisoryUrl: advisoryUrlSchema.optional()
})

export const pluginKillListSchema = z
  .strictObject({
    version: z.literal(1),
    generatedAt: z.string().datetime({ offset: true }),
    plugins: z.array(pluginKillListEntrySchema).max(PLUGIN_KILL_LIST_ENTRY_LIMIT)
  })
  .superRefine((killList, context) => {
    const seen = new Set<string>()
    for (const [index, plugin] of killList.plugins.entries()) {
      if (seen.has(plugin.pluginKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['plugins', index, 'pluginKey'],
          message: `duplicate killed plugin: ${plugin.pluginKey}`
        })
      }
      seen.add(plugin.pluginKey)
    }
  })

export type PluginKillList = z.infer<typeof pluginKillListSchema>
export type PluginKillListEntry = z.infer<typeof pluginKillListEntrySchema>

/** Reject freshly fetched far-future lists that would permanently suppress later revocations. Do not rejudge accepted
 * caches against a slow device clock and accidentally drop active revocations. */
export function isPluginKillListTooFarInFuture(
  killList: PluginKillList,
  now = Date.now()
): boolean {
  return Date.parse(killList.generatedAt) > now + PLUGIN_KILL_LIST_FUTURE_SKEW_MS
}

export function findKilledPlugin(
  killList: PluginKillList,
  pluginKey: string
): PluginKillListEntry | null {
  return killList.plugins.find((plugin) => plugin.pluginKey === pluginKey) ?? null
}
