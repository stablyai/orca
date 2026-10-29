import { z } from 'zod'
import { isQualifiedPluginKey } from '../manifest/plugin-manifest'

export const PLUGIN_KILL_LIST_ENTRY_LIMIT = 4_096
/** Publisher clocks and client clocks disagree by minutes, never by days. */
export const PLUGIN_KILL_LIST_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000

const advisoryUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => new URL(value).protocol === 'https:', 'advisory URL must use HTTPS')

// Why strip, not strict: old clients must keep revoking when a later list adds a field. Ignoring a
// narrowing field over-kills, which is the safe direction. Builds before this parse the list
// strictly, so `kill-list.json` v1 gains no fields while they are supported: publish new data in a
// new file instead.
export const pluginKillListEntrySchema = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  reason: z.string().min(1).max(1_024),
  advisoryUrl: advisoryUrlSchema.optional()
})

export const pluginKillListSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  // Why per entry: one entry this client cannot read must not discard every other revocation.
  plugins: z
    .array(pluginKillListEntrySchema.optional().catch(undefined))
    .max(PLUGIN_KILL_LIST_ENTRY_LIMIT)
    .transform((entries) => {
      const byKey = new Map<string, PluginKillListEntry>()
      for (const entry of entries) {
        if (entry && !byKey.has(entry.pluginKey)) {
          byKey.set(entry.pluginKey, entry)
        }
      }
      return [...byKey.values()]
    })
})

export type PluginKillListEntry = z.infer<typeof pluginKillListEntrySchema>
export type PluginKillList = z.infer<typeof pluginKillListSchema>

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
