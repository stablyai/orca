import { Suspense, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import {
  closePluginUpdateReviewDialog,
  usePluginUpdateReviewDialogStore
} from '@/store/plugins/updates/plugin-update-review-dialog'
import {
  pluginUpdateReviewNoticesKey,
  resolvePluginUpdateReviews,
  usePluginUpdateReviewNoticesStore
} from '@/store/plugins/updates/plugin-update-review-toast'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { useOrcaVersion } from '../state/use-plugin-page-navigation'

const PluginUpdateReviewToast = lazy(() =>
  import('../review/PluginUpdateReviewToast').then((module) => ({
    default: module.PluginUpdateReviewToast
  }))
)
const PluginUpdateAllDialog = lazy(() =>
  import('./PluginUpdateAllDialog').then((module) => ({
    default: module.PluginUpdateAllDialog
  }))
)

async function loadPluginUpdateEntries(pluginKeys: readonly string[]): Promise<PluginListEntry[]> {
  const [{ pluginListEntryFromInstalled }, plugins] = await Promise.all([
    import('../list/plugin-list-entries'),
    window.api.plugins.list()
  ])
  const wanted = new Set(pluginKeys)
  return plugins
    .filter((plugin) => wanted.has(plugin.pluginKey))
    .map((plugin) => pluginListEntryFromInstalled(plugin))
}

const TOAST_ID = 'plugin-update-review'

/** One toast for every held update main reported, however many arrive. */
function useHeldUpdateToast(): void {
  const notices = usePluginUpdateReviewNoticesStore((state) => state.notices)
  useEffect(() => {
    if (notices.length === 0) {
      toast.dismiss(TOAST_ID)
      return
    }
    let current = true
    // Why shown again on resize: sonner measures a toast only when it is shown, and a stale height
    // drops the hovered card under the window edge and overlaps the toasts stacked behind it.
    // Why current: a resize from an older render must not bring back the notices it showed.
    const show = (): void => {
      if (!current) {
        return
      }
      toast.custom(
        () => (
          <Suspense fallback={null}>
            <PluginUpdateReviewToast
              key={pluginUpdateReviewNoticesKey(notices)}
              notices={notices}
              onResolved={resolvePluginUpdateReviews}
              onResize={show}
            />
          </Suspense>
        ),
        {
          id: TOAST_ID,
          duration: Infinity,
          closeButton: false,
          unstyled: true,
          // Why: a swipe or Escape dismisses it too, and those notices are then handled.
          onDismiss: () => resolvePluginUpdateReviews(notices)
        }
      )
    }
    show()
    return () => {
      current = false
    }
  }, [notices])
  // Why: the toast's tree must not outlive this host.
  useEffect(() => () => void toast.dismiss(TOAST_ID), [])
}

/**
 * Held plugin updates outside Settings: the toast, and the review its "Details" opens over
 * whatever the user is doing.
 */
export function PluginUpdateReviewHost(): React.JSX.Element | null {
  useHeldUpdateToast()
  const request = usePluginUpdateReviewDialogStore((state) => state.request)
  const orcaVersion = useOrcaVersion()
  const [loaded, setLoaded] = useState<{ id: number; entries: PluginListEntry[] } | null>(null)
  useEffect(() => {
    if (!request) {
      return
    }
    let stale = false
    void loadPluginUpdateEntries(request.pluginKeys)
      .then((entries) => {
        if (stale) {
          return
        }
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
    <Suspense fallback={null}>
      <PluginUpdateAllDialog
        key={request.id}
        open
        entries={loaded.entries}
        orcaVersion={orcaVersion}
        onClose={closePluginUpdateReviewDialog}
        // Why nothing to reload: main's install events refresh what the rest of Orca shows.
        onUpdated={async () => undefined}
      />
    </Suspense>
  )
}
