import { useCallback, useMemo, useRef, useState } from 'react'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostListing
} from '../../../../preload/api-types'
import type { PluginThemeRegistration } from '../../../../shared/plugins/artifacts/plugin-theme-artifact'
import { pluginHostVersion } from '../../../../shared/plugins/installation/plugin-host-version'
import { buildPluginListEntries, needsNewerOrca } from '../plugins/list/plugin-list-entries'
import { applyPluginAppThemeToSlot } from '../plugins/state/plugin-theme-apply'
import { createPluginPagePreviewCache } from '../plugins/state/use-plugin-catalog'
import { usePluginInstallAction } from '../plugins/state/use-plugin-install-action'

type CatalogSnapshot = {
  installed: readonly PluginHostListEntry[]
  listings: readonly PluginMarketplaceHostListing[]
  orcaVersion: string
}

/** One app theme a catalog offers, as its release previews it. */
export type CatalogAppTheme = {
  value: string
  label: string
  background: string
  accent: string
  pluginName: string
  listing: PluginMarketplaceHostListing
}

/** Themes for one mode that aren't installed and that one click can install and turn on. */
export function catalogAppThemes(
  snapshot: CatalogSnapshot,
  base: 'light' | 'dark',
  installedPluginKeys: ReadonlySet<string>
): CatalogAppTheme[] {
  return buildPluginListEntries(snapshot.installed, snapshot.listings)
    .available.flatMap((entry) => {
      const { listing } = entry
      const release = listing?.release
      if (
        !listing ||
        !release ||
        installedPluginKeys.has(entry.pluginKey) ||
        listing.blockedByKillList ||
        // Why content only: anything that runs code is reviewed on its plugin page first.
        release.execution !== 'data' ||
        needsNewerOrca(entry.minimumOrca, snapshot.orcaVersion)
      ) {
        return []
      }
      return (release.themePreview ?? []).flatMap((preview, index) =>
        preview.base === base
          ? [
              {
                value: `catalog:${entry.pluginKey}:${index}`,
                label: preview.label,
                background: preview.background,
                accent: preview.accent,
                pluginName: entry.name,
                listing
              }
            ]
          : []
      )
    })
    .sort((left, right) => left.label.localeCompare(right.label))
}

/**
 * The cached catalog, read when a theme picker opens rather than at startup. Null until read,
 * and stays null where the host has no plugin catalog (the web client) or the read fails.
 */
function useCatalogSnapshot(): {
  snapshot: CatalogSnapshot | null
  loading: boolean
  load: () => void
} {
  const [snapshot, setSnapshot] = useState<CatalogSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const requestRef = useRef(0)
  const load = useCallback(() => {
    const plugins = window.api?.plugins
    const updater = window.api?.updater
    if (!plugins?.listMarketplacePlugins || !updater?.getVersion) {
      return
    }
    const requestId = ++requestRef.current
    setLoading(true)
    void Promise.all([plugins.list(), plugins.listMarketplacePlugins(), updater.getVersion()])
      .then(([installed, listings, version]) => {
        if (requestId === requestRef.current) {
          setSnapshot({ installed, listings, orcaVersion: pluginHostVersion(version) })
        }
      })
      .catch((cause: unknown) => console.warn('[plugins] catalog themes unavailable:', cause))
      .finally(() => {
        if (requestId === requestRef.current) {
          setLoading(false)
        }
      })
  }, [])
  return { snapshot, loading, load }
}

/**
 * A theme slot's "More themes": the catalog's themes for that mode, and picking one, which
 * installs it through the catalog's own flow (trust prompt included) and then fills the slot.
 */
export function useCatalogAppThemes(
  base: 'light' | 'dark',
  installedThemes: readonly Pick<PluginThemeRegistration, 'pluginKey'>[],
  /** Off with the plugin system: nothing is read and nothing is offered. */
  enabled: boolean
): {
  themes: CatalogAppTheme[]
  /** True only for the first read; later reads keep showing what is known. */
  loading: boolean
  /** Reads the catalog again and clears a failed pick's message. */
  open: () => void
  /** Starts installing the theme a select value names; false when it names none. */
  pick: (value: string) => boolean
  installing: CatalogAppTheme | null
  error: string | null
} {
  const { snapshot, loading, load } = useCatalogSnapshot()
  const themes = useMemo(
    () =>
      enabled && snapshot
        ? catalogAppThemes(snapshot, base, new Set(installedThemes.map((theme) => theme.pluginKey)))
        : [],
    [enabled, snapshot, base, installedThemes]
  )
  const [picked, setPicked] = useState<CatalogAppTheme | null>(null)
  // Why a ref: the install started in the same event reads the pick before it is state.
  const pickedRef = useRef<CatalogAppTheme | null>(null)
  const [previewCache] = useState(createPluginPagePreviewCache)
  const fetchPreview = useCallback(
    (listing: PluginMarketplaceHostListing) => previewCache.fetch(listing),
    [previewCache]
  )
  const onInstalled = useCallback(async () => load(), [load])
  const applyThemes = useCallback(
    async (pluginKey: string) => {
      const pick = pickedRef.current
      return pick?.listing.pluginKey === pluginKey
        ? applyPluginAppThemeToSlot(pluginKey, { base, label: pick.label })
        : false
    },
    [base]
  )
  const install = usePluginInstallAction({ fetchPreview, onInstalled, applyThemes })
  const phase = picked ? install.phaseOf(picked.listing.pluginKey) : null
  // Why: reopening the picker is the retry, so a failed pick's message goes with it.
  const open = (): void => {
    if (!enabled) {
      return
    }
    if (picked && phase?.kind === 'error') {
      install.dismiss(picked.listing.pluginKey)
    }
    load()
  }
  const pick = (value: string): boolean => {
    const theme = themes.find((candidate) => candidate.value === value)
    if (!theme) {
      // Why: a later choice wins over a catalog pick still downloading.
      pickedRef.current = null
      return false
    }
    pickedRef.current = theme
    setPicked(theme)
    void install.install(theme.listing)
    return true
  }
  return {
    themes,
    loading: enabled && loading && !snapshot,
    open,
    pick,
    installing: phase?.kind === 'installing' ? picked : null,
    error: phase?.kind === 'error' ? phase.message : null
  }
}
