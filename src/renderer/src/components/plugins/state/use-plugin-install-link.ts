import { useEffect, useLayoutEffect, useRef } from 'react'
import type { PluginMarketplaceHostSourceState } from '../../../../../preload/api-types'
import { isSameGitRepository } from '../../../../../shared/plugins/catalog/plugin-marketplace'
import type { PluginInstallLinkCatalog } from '../../../../../shared/plugins/catalog/plugin-install-link'
import { usePluginPreviewRequestStore } from '@/store/plugin-preview-request'

export type { PluginCatalogToAdd } from '@/store/plugin-preview-request'

/** Whether the link's catalog is one the user already has; official always counts as known. */
export function isKnownInstallLinkCatalog(
  catalog: PluginInstallLinkCatalog,
  sources: readonly PluginMarketplaceHostSourceState[]
): boolean {
  return (
    catalog.kind === 'official' ||
    sources.some((source) => isSameGitRepository(source.source.url, catalog.source.url))
  )
}

/**
 * Serves an install link once the catalog has loaded: opens the plugin's page, or first asks
 * before adding a catalog the user doesn't have. Never installs.
 */
export function usePluginInstallLink({
  sources,
  loading,
  loadMarketplaceData,
  open
}: {
  sources: readonly PluginMarketplaceHostSourceState[]
  loading: boolean
  loadMarketplaceData: () => Promise<void>
  open?: (pluginKey: string) => void
}) {
  const link = usePluginPreviewRequestStore((state) => state.link)
  const catalogToAdd = usePluginPreviewRequestStore((state) => state.catalogToAdd)
  const openRef = useRef(open)
  useLayoutEffect(() => {
    openRef.current = open
  })
  useEffect(() => {
    if (!link || loading) {
      return
    }
    if (link.catalog.kind === 'official' || isKnownInstallLinkCatalog(link.catalog, sources)) {
      usePluginPreviewRequestStore.setState({ link: null, catalogToAdd: null })
      openRef.current?.(link.pluginKey)
    } else {
      usePluginPreviewRequestStore.setState({
        link: null,
        catalogToAdd: { pluginKey: link.pluginKey, source: link.catalog.source }
      })
    }
  }, [link, loading, sources])

  const confirmCatalog = async (): Promise<void> => {
    if (!catalogToAdd) {
      return
    }
    await window.api.plugins.addMarketplace(catalogToAdd.source)
    await loadMarketplaceData()
    usePluginPreviewRequestStore.setState({ catalogToAdd: null })
    openRef.current?.(catalogToAdd.pluginKey)
  }
  const cancelCatalog = (): void => usePluginPreviewRequestStore.setState({ catalogToAdd: null })
  return { catalogToAdd, confirmCatalog, cancelCatalog }
}
