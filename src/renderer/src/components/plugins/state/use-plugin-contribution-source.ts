import { useEffect, useMemo, useState } from 'react'
import type { PluginHostListEntry } from '../../../../../preload/api-types'
import type { PluginManifest } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { usePluginIconThemes } from '@/store/plugin-icon-themes'
import {
  ensurePluginLanguagePacksLoaded,
  usePluginLanguagePackStore
} from '@/store/plugin-language-packs'
import {
  pluginSyntaxRevisionKey,
  usePluginSyntaxFailureStore
} from '@/store/plugin-syntax-failures'
import { usePluginSyntaxes } from '@/store/plugin-syntax-packs'
import { usePluginTerminalThemes, usePluginThemes } from '@/store/plugin-themes'
import {
  EMPTY_CONTRIBUTION_SOURCE,
  manifestContributionSource,
  type PluginContributionSource
} from '../presentation/plugin-contributions'

/** What an installed plugin adds right now, from Orca's live registrations; empty for others. */
export function useInstalledPluginContributionSource(
  plugin: PluginHostListEntry | null
): PluginContributionSource {
  const appThemes = usePluginThemes()
  const terminalThemes = usePluginTerminalThemes()
  const iconThemes = usePluginIconThemes()
  const syntaxes = usePluginSyntaxes()
  // Why the raw store: usable-only filtering would hide the incomplete packs this page explains.
  const languagePacks = usePluginLanguagePackStore((state) => state.entries)
  const failures = usePluginSyntaxFailureStore((state) => state.failures)
  useEffect(() => ensurePluginLanguagePacksLoaded(), [])

  return useMemo(() => {
    if (!plugin) {
      return EMPTY_CONTRIBUTION_SOURCE
    }
    const ours = <Entry extends { pluginKey: string }>(entries: readonly Entry[]): Entry[] =>
      entries.filter((entry) => entry.pluginKey === plugin.pluginKey)
    return {
      appThemes: ours(appThemes),
      terminalThemes: ours(terminalThemes),
      iconThemes: ours(iconThemes),
      syntaxes: ours(syntaxes).map((syntax) => ({
        ...syntax,
        failed: Boolean(failures[pluginSyntaxRevisionKey(syntax)])
      })),
      languages: ours(languagePacks),
      panels: plugin.panels.map((panel) => panel.title),
      recipes: plugin.vmRecipes?.map((recipe) => recipe.name) ?? []
    }
  }, [plugin, appThemes, terminalThemes, iconThemes, syntaxes, languagePacks, failures])
}

/** An installed plugin's declared manifest, read when its page opens; undefined until read, null if
 *  unreadable. Keyed by revision too, so a same-key update never pairs old contents with new trust. */
export function useInstalledPluginManifest(
  pluginKey: string | null,
  revision: string | null
): PluginManifest | null | undefined {
  const [loaded, setLoaded] = useState<{
    key: string
    manifest: PluginManifest | null
  } | null>(null)
  const key = pluginKey ? `${pluginKey}@${revision ?? ''}` : null
  useEffect(() => {
    if (!pluginKey || !key) {
      return
    }
    let stale = false
    window.api.plugins
      .getInstalledManifest({ pluginKey })
      .then((manifest) => {
        if (!stale) {
          setLoaded({ key, manifest })
        }
      })
      .catch((cause: unknown) => {
        console.warn('[plugins] installed manifest read failed:', cause)
        if (!stale) {
          setLoaded({ key, manifest: null })
        }
      })
    return () => {
      stale = true
    }
  }, [pluginKey, key])
  return loaded && loaded.key === key ? loaded.manifest : undefined
}

function hasLiveContent(source: PluginContributionSource): boolean {
  return (
    source.appThemes.length +
      source.terminalThemes.length +
      source.iconThemes.length +
      source.syntaxes.length +
      source.languages.length >
    0
  )
}

/**
 * Live registrations while the plugin is on (they carry coverage and grammar failures); otherwise
 * what its manifest declares, so a plugin under review or turned off still names what it adds.
 */
export function useInstalledPluginContributions(
  plugin: PluginHostListEntry | null
): PluginContributionSource {
  const live = useInstalledPluginContributionSource(plugin)
  const manifest = useInstalledPluginManifest(
    plugin?.pluginKey ?? null,
    plugin?.consentFingerprint ?? plugin?.source?.contentHash ?? null
  )
  return useMemo(
    () => (hasLiveContent(live) || !manifest ? live : manifestContributionSource(manifest)),
    [live, manifest]
  )
}
