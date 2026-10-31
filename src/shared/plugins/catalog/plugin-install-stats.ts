import { z } from 'zod'
import { isQualifiedPluginKey } from '../manifest/plugin-manifest'

export const PLUGIN_INSTALL_STATS_ENTRY_LIMIT = 10_000

const installCountSchema = z.number().int().nonnegative().max(1e12)

// Why loose and per-entry: the site may add fields or odd rows; counts are display-only.
const pluginInstallStatsEntrySchema = z.object({ installs: installCountSchema })

export const pluginInstallStatsSchema = z.object({
  schemaVersion: z.literal(1),
  // Why nullable: the site publishes `null` with no plugins before its first stats build.
  generatedAt: z.string().datetime({ offset: true }).nullable(),
  plugins: z
    .record(z.string(), pluginInstallStatsEntrySchema.optional().catch(undefined))
    .refine(
      (plugins) => Object.keys(plugins).length <= PLUGIN_INSTALL_STATS_ENTRY_LIMIT,
      'too many plugin entries'
    )
    .transform((plugins) => {
      const installs: Record<string, number> = {}
      for (const [pluginKey, entry] of Object.entries(plugins)) {
        if (entry && isQualifiedPluginKey(pluginKey)) {
          installs[pluginKey] = entry.installs
        }
      }
      return installs
    })
})

/** Parsed stats: total installs keyed by qualified plugin key. */
export type PluginInstallStats = {
  generatedAt: string | null
  installs: Record<string, number>
}

export function parsePluginInstallStats(value: unknown): PluginInstallStats {
  const parsed = pluginInstallStatsSchema.parse(value)
  return { generatedAt: parsed.generatedAt, installs: parsed.plugins }
}
