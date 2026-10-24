import { useEffect, useState } from 'react'
import type {
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing
} from '../../../../preload/api-types'
import { pluginExecutionProfile } from '../../../../shared/plugins/plugin-execution-profile'
import { PLUGIN_CONTRIBUTION_SUMMARY_LIMIT } from '../../../../shared/plugins/plugin-contribution-summary'
import type { PluginHostImages } from '../../../../shared/plugins/plugin-image-url'
import type { PluginListEntry } from '../plugin-catalog/plugin-list-entries'
import {
  installedPluginTrust,
  pluginPageExecutionProfile,
  pluginPointsFromManifest,
  pluginPointsFromSummary,
  pluginTrust,
  type PluginTrust
} from './plugin-access-profile'
import type { PluginPagePreview } from './use-plugin-catalog'
import { useInstalledPluginManifest } from './use-plugin-contribution-source'

/** A shortcut a plugin binds, by the key as written and the command it runs. */
export type PluginPageShortcut = { key: string; command: string }

/**
 * Whether a fetched preview is the release the page rendered. Preview reads the current catalog,
 * so a page pinned to an older listing must never install or approve what it didn't show.
 */
export function previewMatchesListing(
  preview: PluginMarketplaceHostInstallPreview,
  listing: PluginMarketplaceHostListing
): boolean {
  if (preview.marketplaceCommit !== listing.marketplaceCommit) {
    return false
  }
  return (
    !listing.release ||
    (preview.resolvedCommit === listing.release.commit &&
      preview.contentHash === listing.release.contentHash &&
      pluginExecutionProfile(preview.manifest) === listing.release.execution)
  )
}

/** Everything a listing vouches for that the page shows; any change is a different release. */
export function listingIdentity(listing: PluginMarketplaceHostListing): string {
  const release = listing.release
  return [
    listing.marketplaceCommit,
    release?.commit ?? '',
    release?.contentHash ?? '',
    release?.execution ?? ''
  ].join(':')
}

/** Everything a plugin page shows, pinned to the listing it opened on. */
export function usePluginPageModel({
  entry,
  fetchPreview,
  refreshing
}: {
  entry: PluginListEntry
  fetchPreview: (listing: PluginMarketplaceHostListing) => Promise<PluginPagePreview>
  /** A catalog refresh is in flight; what the page shows may be about to change. */
  refreshing: boolean
}) {
  const plugin = entry.installed
  // Why pinned: a catalog refresh mid-view must never swap the rows above an armed button.
  const [pinned, setPinned] = useState(entry.listing)
  const listing = plugin ? entry.listing : pinned
  const [preview, setPreview] = useState<PluginMarketplaceHostInstallPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(!plugin && Boolean(listing))
  const [previewFailed, setPreviewFailed] = useState(false)
  const [previewAttempt, setPreviewAttempt] = useState(0)

  useEffect(() => {
    if (plugin || !listing) {
      return
    }
    let stale = false
    setPreview(null)
    setPreviewLoading(true)
    setPreviewFailed(false)
    void fetchPreview(listing).then((result) => {
      if (!stale) {
        setPreview(result.ok ? result.preview : null)
        setPreviewFailed(!result.ok)
        setPreviewLoading(false)
      }
    })
    return () => {
      stale = true
    }
  }, [plugin, listing, fetchPreview, previewAttempt])

  const installedManifest = useInstalledPluginManifest(
    plugin?.pluginKey ?? null,
    plugin?.consentFingerprint ?? plugin?.source?.contentHash ?? null
  )
  const previewMatches = preview && listing ? previewMatchesListing(preview, listing) : null
  const newerListed =
    !plugin &&
    entry.listing !== null &&
    pinned !== null &&
    listingIdentity(entry.listing) !== listingIdentity(pinned)
  // Why a mismatched preview counts too: it is the catalog's newer release, not what is shown.
  const stale = newerListed || previewMatches === false
  // Why disarm while refreshing: the listing under the button may be replaced any moment.
  const disarmed = stale || refreshing
  // Why the mismatched preview is ignored: its rows would describe a release the page isn't on.
  const shownPreview = previewMatches === false ? null : preview
  const summary = listing?.release?.contributes

  const execution = pluginPageExecutionProfile({
    installed: plugin,
    installedManifest,
    listing,
    previewManifest: shownPreview?.manifest ?? null
  })
  let trust: PluginTrust | null
  if (plugin) {
    trust =
      plugin.execution === undefined && installedManifest === undefined
        ? null
        : installedPluginTrust(plugin, installedManifest)
  } else {
    trust = pluginTrust({
      execution,
      // Why the manifest first: the summary is capped, so a full one may still omit points.
      points: shownPreview
        ? pluginPointsFromManifest(shownPreview.manifest)
        : summary && summary.length < PLUGIN_CONTRIBUTION_SUMMARY_LIMIT
          ? pluginPointsFromSummary(summary)
          : null,
      hasWorker: shownPreview ? shownPreview.manifest.main !== undefined : false
    })
  }

  // Why the summary first: install refuses a manifest that asks for anything else.
  const capabilities = plugin
    ? plugin.capabilities
    : (listing?.release?.capabilities?.map((kind) => ({ kind, description: kind })) ??
      shownPreview?.manifest.capabilities.map((capability) => ({
        kind: capability.kind,
        description: capability.kind
      })) ??
      null)

  let shortcuts: PluginPageShortcut[] | null
  if (plugin) {
    shortcuts = plugin.commands.flatMap((command) =>
      command.keybindings.map((binding) => ({ key: binding.key, command: command.title }))
    )
  } else if (shownPreview) {
    const { commands, keybindings } = shownPreview.manifest.contributes
    shortcuts = keybindings.map((binding) => ({
      key: binding.key,
      command: commands.find((command) => command.id === binding.command)?.title ?? binding.command
    }))
  } else {
    shortcuts =
      summary
        ?.filter((item) => item.kind === 'keybindings')
        .map((item) => ({ key: item.name, command: item.detail ?? item.name })) ?? null
  }

  const images: PluginHostImages | undefined =
    plugin?.images ?? listing?.images ?? shownPreview?.images
  return {
    plugin,
    listing,
    preview: shownPreview,
    previewLoading,
    previewFailed,
    retryPreview: () => setPreviewAttempt((attempt) => attempt + 1),
    showNewer: () => setPinned(entry.listing),
    stale,
    disarmed,
    execution,
    trust,
    capabilities,
    shortcuts,
    images,
    installedManifest
  }
}
