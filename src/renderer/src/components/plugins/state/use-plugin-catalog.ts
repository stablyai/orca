import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { usePluginPreviewRequestStore } from '@/store/plugin-preview-request'
import { PluginPreviewCache } from './plugin-preview-cache'
import { requestPluginInstallCounts } from '@/store/plugin-install-counts'

/** A plugin page's manifest read; a failure means nothing is known, not "nothing needed". */
export type PluginPagePreview =
  | { ok: true; preview: PluginMarketplaceHostInstallPreview }
  | { ok: false }

function marketplaceError(cause: unknown, fallback: string): string {
  console.warn('[plugins] marketplace action failed:', cause)
  return fallback
}

/**
 * The plugin catalog: its sources and listings, refresh, and the install/update preview a
 * listing opens. Requests a newer load superseded, or that finish after unmount, are dropped.
 */
export function usePluginCatalog({
  onRefreshInstalled,
  onOpenRequested
}: {
  onRefreshInstalled?: () => Promise<void>
  /** A plugin asked for from outside Settings (a file-type suggestion); opens its page. */
  onOpenRequested?: (pluginKey: string) => void
}) {
  const [sources, setSources] = useState<PluginMarketplaceHostSourceState[]>([])
  const [listings, setListings] = useState<PluginMarketplaceHostListing[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(false)
  const requestRef = useRef(0)
  const [previewCache] = useState(
    () =>
      new PluginPreviewCache((listing) =>
        window.api.plugins
          .previewMarketplacePlugin({
            marketplaceSourceId: listing.marketplaceSourceId,
            pluginKey: listing.pluginKey
          })
          .then((preview): PluginPagePreview => ({ ok: true, preview }))
          .catch((cause: unknown): PluginPagePreview => {
            console.warn('[plugins] plugin page preview failed:', cause)
            return { ok: false }
          })
      )
  )

  const loadMarketplaceData = useCallback(async (): Promise<void> => {
    const requestId = ++requestRef.current
    requestPluginInstallCounts()
    try {
      const [nextSources, nextListings] = await Promise.all([
        window.api.plugins.listMarketplaces(),
        window.api.plugins.listMarketplacePlugins()
      ])
      if (mountedRef.current && requestId === requestRef.current) {
        setSources(nextSources)
        setListings(nextListings)
        previewCache.retainListed(nextListings)
        setError(null)
      }
    } catch (cause) {
      if (mountedRef.current && requestId === requestRef.current) {
        setError(
          marketplaceError(
            cause,
            translate(
              'auto.components.settings.PluginMarketplaceBrowser.loadFailed',
              'Could not load catalog plugins.'
            )
          )
        )
      }
    } finally {
      if (mountedRef.current && requestId === requestRef.current) {
        setLoading(false)
      }
    }
  }, [previewCache])

  useEffect(() => {
    mountedRef.current = true
    void loadMarketplaceData()
    return () => {
      mountedRef.current = false
      requestRef.current += 1
    }
  }, [loadMarketplaceData])

  const refresh = async (): Promise<void> => {
    setRefreshBusy(true)
    setError(null)
    try {
      await Promise.all([window.api.plugins.refreshMarketplaces({}), onRefreshInstalled?.()])
      await loadMarketplaceData()
    } catch (cause) {
      if (mountedRef.current) {
        setError(
          marketplaceError(
            cause,
            translate(
              'auto.components.settings.PluginMarketplaceBrowser.refreshFailed',
              "Couldn't refresh catalogs. Try again."
            )
          )
        )
      }
    } finally {
      if (mountedRef.current) {
        setRefreshBusy(false)
      }
    }
  }

  const previewRequest = usePluginPreviewRequestStore((state) => state.request)
  const openRequestedRef = useRef(onOpenRequested)
  useLayoutEffect(() => {
    openRequestedRef.current = onOpenRequested
  })
  // Why the page: a suggestion leads to the same one-action install as the catalog, not a dialog.
  useEffect(() => {
    if (!previewRequest || loading) {
      return
    }
    // Why clear even without a match: a request that can't be served must not pop open later.
    usePluginPreviewRequestStore.setState({ request: null })
    const listing = listings.find(
      (candidate) =>
        candidate.marketplaceSourceId === previewRequest.marketplaceSourceId &&
        candidate.pluginKey === previewRequest.pluginKey
    )
    if (listing) {
      openRequestedRef.current?.(listing.pluginKey)
    }
  }, [previewRequest, listings, loading])

  const fetchPreview = useCallback(
    (listing: PluginMarketplaceHostListing) => previewCache.fetch(listing),
    [previewCache]
  )

  return {
    fetchPreview,
    sources,
    listings,
    loading,
    refreshBusy,
    error,
    loadMarketplaceData,
    refresh
  }
}
