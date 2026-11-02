import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePluginPreviewRequestStore } from '@/store/plugin-preview-request'
import type { PluginListEntry } from '../list/plugin-list-entries'
import type { PluginPageNavigation } from './use-plugin-page-navigation'

/**
 * The update dialog's open state, and the "Review" from the held-update toast: one plugin opens
 * its own update review, several (or one no longer pending) show the Updates list. Opening is
 * all the toast does; approving stays in the dialog.
 */
export function usePluginUpdateDialog({
  ready,
  updates,
  page,
  showUpdates,
  reloadCatalogs
}: {
  /** Installed plugins and catalogs are read, so `updates` is complete. */
  ready: boolean
  updates: readonly PluginListEntry[]
  /** Left for the list when the Updates list is asked for from a plugin's page. */
  page: Pick<PluginPageNavigation, 'openKey' | 'back'>
  showUpdates: () => void
  /** Re-reads main's catalogs, which the update pass refreshed after this pane loaded them. */
  reloadCatalogs: () => Promise<void>
}) {
  // Why a count: each open mounts a fresh dialog, so its previews and results start clean.
  const [opens, setOpens] = useState(0)
  const [entries, setEntries] = useState<readonly PluginListEntry[] | null>(null)
  const open = (next: readonly PluginListEntry[]): void => {
    setOpens((count) => count + 1)
    setEntries(next)
  }
  const handlers = useRef({ open, showUpdates, page })
  useLayoutEffect(() => {
    handlers.current = { open, showUpdates, page }
  })
  const request = usePluginPreviewRequestStore((state) => state.updateReview)
  const [reloadedFor, setReloadedFor] = useState<typeof request>(null)
  const reloadingFor = useRef<typeof request>(null)
  useEffect(() => {
    if (!request || !ready) {
      return
    }
    if (reloadedFor !== request) {
      if (reloadingFor.current !== request) {
        reloadingFor.current = request
        void reloadCatalogs().finally(() => setReloadedFor(request))
      }
      return
    }
    // Why clear first: a request that can't be served must not pop open later.
    usePluginPreviewRequestStore.setState({ updateReview: null })
    const entry = request.pluginKey
      ? updates.find((candidate) => candidate.pluginKey === request.pluginKey)
      : undefined
    if (entry) {
      handlers.current.open([entry])
    } else {
      if (handlers.current.page.openKey) {
        handlers.current.page.back()
      }
      handlers.current.showUpdates()
    }
  }, [request, ready, updates, reloadedFor, reloadCatalogs])
  return { opens, entries, open, close: () => setEntries(null) }
}
