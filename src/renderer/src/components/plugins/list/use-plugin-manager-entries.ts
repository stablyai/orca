import { useMemo } from 'react'
import type { Translate } from '@/i18n/use-translate'
import { usePluginAutoUpdatesStore } from '@/store/plugins/updates/plugin-auto-updates'
import { sortByAttention } from '../presentation/plugin-status-presentation'
import { buildPluginListEntries } from './plugin-list-entries'

type EntryOptions = NonNullable<Parameters<typeof buildPluginListEntries>[2]>

/** Installed and catalog entries for the plugin manager, installed ones needing attention first. */
export function usePluginManagerEntries(
  plugins: Parameters<typeof buildPluginListEntries>[0],
  listings: Parameters<typeof buildPluginListEntries>[1],
  sources: EntryOptions['sources'],
  orcaVersion: EntryOptions['orcaVersion'],
  t: Translate
): ReturnType<typeof buildPluginListEntries> {
  const autoUpdated = usePluginAutoUpdatesStore((state) => state.updated)
  const autoNeedsReview = usePluginAutoUpdatesStore((state) => state.needsReview)
  return useMemo(() => {
    const built = buildPluginListEntries(
      plugins,
      listings,
      {
        sources,
        orcaVersion,
        autoUpdates: { updated: autoUpdated, needsReview: autoNeedsReview }
      },
      t
    )
    return {
      ...built,
      installed: sortByAttention(built.installed, (entry) => Boolean(entry.updateVersion))
    }
  }, [plugins, listings, sources, orcaVersion, autoUpdated, autoNeedsReview, t])
}
