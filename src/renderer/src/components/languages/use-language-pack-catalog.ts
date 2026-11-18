import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { PluginMarketplaceHostSourceState } from '../../../../preload/api/plugins/plugin-host-api'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import {
  requestPluginInstallCounts,
  usePluginInstallCountsStore
} from '@/store/plugins/installation/plugin-install-counts'
import {
  catalogLanguagePacks,
  sortCatalogLanguagePacks,
  type CatalogLanguagePack
} from './language-pack-options'

type LanguagePackCatalog = {
  packs: CatalogLanguagePack[]
  loaded: boolean
  error: boolean
}
const useCatalog = create<LanguagePackCatalog>(() => ({ packs: [], loaded: false, error: false }))

usePluginInstallCountsStore.subscribe((state) => {
  const current = useCatalog.getState()
  if (current.packs.length > 1) {
    useCatalog.setState({ packs: sortCatalogLanguagePacks(current.packs, state.counts) })
  }
})

let pending: Promise<LanguagePackCatalog> | null = null

export function loadLanguagePackCatalog(refresh = false): Promise<LanguagePackCatalog> {
  // Why: plugins run only in the desktop app; the web client has no catalog to read.
  if (isWebClientLocation()) {
    useCatalog.setState({ packs: [], loaded: true, error: false })
    return Promise.resolve(useCatalog.getState())
  }
  if (pending) {
    return refresh ? pending.then(() => loadLanguagePackCatalog(true)) : pending
  }
  pending = (async () => {
    requestPluginInstallCounts()
    try {
      if (refresh) {
        await window.api.plugins.refreshMarketplaces({})
      }
      const emptySources: PluginMarketplaceHostSourceState[] = []
      const [sources, listings] = await Promise.all([
        (window.api.plugins.listMarketplaces?.() ?? Promise.resolve(emptySources)).catch(
          () => emptySources
        ),
        window.api.plugins.listMarketplacePlugins()
      ])
      const catalogById = new Map(sources.map((source) => [source.id, source] as const))
      const packs = catalogLanguagePacks(
        listings,
        catalogById,
        usePluginInstallCountsStore.getState().counts
      )
      useCatalog.setState({ packs, loaded: true, error: false })
    } catch {
      useCatalog.setState({ loaded: true, error: true })
    }
    return useCatalog.getState()
  })().finally(() => {
    pending = null
  })
  return pending
}

export function useLanguagePackCatalog(active = true) {
  const state = useCatalog(
    useShallow((state) => ({ packs: state.packs, loaded: state.loaded, error: state.error }))
  )
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => {
    if (!active) {
      return
    }
    void loadLanguagePackCatalog()
    if (isWebClientLocation()) {
      return
    }
    return window.api.plugins.onChanged((event) => {
      if (event?.contentPacksChanged !== false) {
        void loadLanguagePackCatalog()
      }
    })
  }, [active])
  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    await loadLanguagePackCatalog(true)
    setRefreshing(false)
  }
  return { ...state, refreshing, refresh }
}
