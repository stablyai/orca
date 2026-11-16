import { useEffect, useState } from 'react'
import {
  closePluginUpdateReviewDialog,
  usePluginUpdateReviewDialogStore
} from '@/store/plugins/updates/plugin-update-review-dialog'
import { pluginListEntryFromInstalled, type PluginListEntry } from '../list/plugin-list-entries'
import { useOrcaVersion } from '../state/use-plugin-page-navigation'
import { PluginUpdateAllDialog } from './PluginUpdateAllDialog'

/**
 * The update review outside Settings: the held-update toast's "Details" opens it over whatever
 * the user is doing, instead of sending them to Settings → Plugins.
 */
export function PluginUpdateReviewHost(): React.JSX.Element | null {
  const request = usePluginUpdateReviewDialogStore((state) => state.request)
  const orcaVersion = useOrcaVersion()
  const [loaded, setLoaded] = useState<{ id: number; entries: PluginListEntry[] } | null>(null)
  useEffect(() => {
    if (!request) {
      return
    }
    let stale = false
    void window.api.plugins
      .list()
      .then((plugins) => {
        if (stale) {
          return
        }
        const wanted = new Set(request.pluginKeys)
        const entries = plugins
          .filter((plugin) => wanted.has(plugin.pluginKey))
          .map((plugin) => pluginListEntryFromInstalled(plugin))
        // Why close when empty: the plugins were removed since the toast, so nothing is left to review.
        if (entries.length === 0) {
          closePluginUpdateReviewDialog()
          return
        }
        setLoaded({ id: request.id, entries })
      })
      .catch((cause: unknown) => {
        console.warn('[plugins] update review list failed:', cause)
        if (!stale) {
          closePluginUpdateReviewDialog()
        }
      })
    return () => {
      stale = true
    }
  }, [request])
  if (!request || loaded?.id !== request.id) {
    return null
  }
  return (
    <PluginUpdateAllDialog
      key={request.id}
      open
      entries={loaded.entries}
      orcaVersion={orcaVersion}
      onClose={closePluginUpdateReviewDialog}
      onUpdated={async () => undefined}
    />
  )
}
