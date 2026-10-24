import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { usePluginPreviewRequestStore } from '@/store/plugin-preview-request'
import type { PluginMarketplacePreviewMode } from './PluginMarketplacePreviewDialog'

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
  installedPlugins,
  onInstalled,
  onRefreshInstalled
}: {
  installedPlugins: readonly PluginHostListEntry[]
  onInstalled: (pluginKey: string) => Promise<void>
  onRefreshInstalled?: () => Promise<void>
}) {
  const [sources, setSources] = useState<PluginMarketplaceHostSourceState[]>([])
  const [listings, setListings] = useState<PluginMarketplaceHostListing[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PluginMarketplaceHostInstallPreview | null>(null)
  const [previewMode, setPreviewMode] = useState<PluginMarketplacePreviewMode>('install')
  // Why: opened from a plugin page, the review skips what the page already showed.
  const [previewAccessOnly, setPreviewAccessOnly] = useState(false)
  const [previewBusyKey, setPreviewBusyKey] = useState<string | null>(null)
  const [installBusy, setInstallBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const mountedRef = useRef(false)
  const requestRef = useRef(0)
  const previewRequestRef = useRef(0)

  const loadMarketplaceData = useCallback(async (): Promise<void> => {
    const requestId = ++requestRef.current
    try {
      const [nextSources, nextListings] = await Promise.all([
        window.api.plugins.listMarketplaces(),
        window.api.plugins.listMarketplacePlugins()
      ])
      if (mountedRef.current && requestId === requestRef.current) {
        setSources(nextSources)
        setListings(nextListings)
        setError(null)
      }
    } catch (cause) {
      if (mountedRef.current && requestId === requestRef.current) {
        setError(
          marketplaceError(
            cause,
            translate(
              'auto.components.settings.PluginMarketplaceBrowser.loadFailed',
              'Could not load marketplace plugins.'
            )
          )
        )
      }
    } finally {
      if (mountedRef.current && requestId === requestRef.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void loadMarketplaceData()
    return () => {
      mountedRef.current = false
      requestRef.current += 1
      previewRequestRef.current += 1
    }
  }, [loadMarketplaceData])

  const installedByKey = useMemo(
    () => new Map(installedPlugins.map((plugin) => [plugin.pluginKey, plugin])),
    [installedPlugins]
  )
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
              "Couldn't refresh marketplaces. Try again."
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

  const openPreview = async (
    listing: PluginMarketplaceHostListing,
    update: boolean,
    accessOnly = false
  ): Promise<void> => {
    const requestId = ++previewRequestRef.current
    setPreviewBusyKey(listing.pluginKey)
    setActionError(null)
    setError(null)
    try {
      const nextPreview = update
        ? await window.api.plugins.previewMarketplaceUpdate({ pluginKey: listing.pluginKey })
        : await window.api.plugins.previewMarketplacePlugin({
            marketplaceSourceId: listing.marketplaceSourceId,
            pluginKey: listing.pluginKey
          })
      if (mountedRef.current && requestId === previewRequestRef.current) {
        setPreviewMode(update ? 'update' : 'install')
        setPreviewAccessOnly(accessOnly)
        setPreview(nextPreview)
      }
    } catch (cause) {
      if (mountedRef.current && requestId === previewRequestRef.current) {
        setError(
          marketplaceError(
            cause,
            translate(
              'auto.components.settings.PluginMarketplaceBrowser.previewFailed',
              "Couldn't load this plugin. Refresh and try again."
            )
          )
        )
      }
    } finally {
      if (mountedRef.current && requestId === previewRequestRef.current) {
        setPreviewBusyKey(null)
      }
    }
  }

  const previewRequest = usePluginPreviewRequestStore((state) => state.request)
  const openPreviewRef = useRef(openPreview)
  useLayoutEffect(() => {
    openPreviewRef.current = openPreview
  })
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
      void openPreviewRef.current(listing, false)
    }
  }, [previewRequest, listings, loading])

  const installPreview = async (): Promise<void> => {
    if (!preview || installBusy) {
      return
    }
    setInstallBusy(true)
    setActionError(null)
    try {
      const result = await window.api.plugins.installMarketplacePlugin({
        marketplaceSourceId: preview.marketplaceSourceId,
        marketplaceCommit: preview.marketplaceCommit,
        pluginKey: preview.pluginKey,
        resolvedCommit: preview.resolvedCommit
      })
      if (!result.ok) {
        throw new Error(result.error)
      }
      setPreview(null)
      await onInstalled(result.pluginKey)
    } catch (cause) {
      if (mountedRef.current) {
        setActionError(
          marketplaceError(
            cause,
            translate(
              'auto.components.settings.PluginMarketplaceBrowser.installFailed',
              'Could not install this plugin. The reviewed source may have changed.'
            )
          )
        )
      }
    } finally {
      if (mountedRef.current) {
        setInstallBusy(false)
      }
    }
  }

  const currentVersion = Boolean(
    preview && installedByKey.get(preview.pluginKey)?.source?.contentHash === preview.contentHash
  )

  // Why: the plugin page reads the same preview the install dialog would, without opening it.
  const previewCacheRef = useRef(new Map<string, Promise<PluginPagePreview>>())
  const fetchPreview = useCallback(
    (listing: PluginMarketplaceHostListing): Promise<PluginPagePreview> => {
      const key = `${listing.marketplaceSourceId}:${listing.pluginKey}:${listing.marketplaceCommit}`
      let request = previewCacheRef.current.get(key)
      if (!request) {
        request = window.api.plugins
          .previewMarketplacePlugin({
            marketplaceSourceId: listing.marketplaceSourceId,
            pluginKey: listing.pluginKey
          })
          .then((preview): PluginPagePreview => ({ ok: true, preview }))
          .catch((cause: unknown): PluginPagePreview => {
            console.warn('[plugins] plugin page preview failed:', cause)
            // Why: only successes are cached, so Retry asks again.
            previewCacheRef.current.delete(key)
            return { ok: false }
          })
        previewCacheRef.current.set(key, request)
      }
      return request
    },
    []
  )

  return {
    fetchPreview,
    sources,
    listings,
    loading,
    refreshBusy,
    error,
    preview,
    previewMode,
    previewAccessOnly,
    previewBusyKey,
    installBusy,
    actionError,
    installedByKey,
    currentVersion,
    loadMarketplaceData,
    refresh,
    openPreview,
    installPreview,
    closePreview: () => setPreview(null)
  }
}
