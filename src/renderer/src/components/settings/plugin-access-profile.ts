import type {
  PluginHostListEntry,
  PluginMarketplaceHostListing
} from '../../../../preload/api-types'
import {
  pluginExecutionProfile,
  type PluginExecutionProfile
} from '../../../../shared/plugins/plugin-execution-profile'
import type { PluginManifest } from '../../../../shared/plugins/plugin-manifest'

/**
 * The execution profile a plugin page describes, or null while it is unknown.
 * Why never from contributions or `hasWorker`: commands and instructions run under the user's
 * authority without a worker, so only the verified profile may say "content only".
 */
export function pluginPageExecutionProfile({
  installed,
  installedManifest,
  listing,
  previewManifest
}: {
  installed: Pick<PluginHostListEntry, 'execution'> | null
  /** Read on demand for hosts whose list predates `execution`. */
  installedManifest: PluginManifest | null | undefined
  listing: Pick<PluginMarketplaceHostListing, 'release'> | null
  previewManifest: PluginManifest | null
}): PluginExecutionProfile | null {
  if (installed) {
    return (
      installed.execution ?? (installedManifest ? pluginExecutionProfile(installedManifest) : null)
    )
  }
  // Why release first: install and preview refuse bytes whose manifest profile differs from it.
  return (
    listing?.release?.execution ??
    (previewManifest ? pluginExecutionProfile(previewManifest) : null)
  )
}

export type PluginConsentTier = 'worker' | 'instructional' | 'panel' | 'declarative'

/** The trust tier a review describes, from the installed manifest's verified profile. */
export function pluginConsentTier(
  plugin: Pick<
    PluginHostListEntry,
    'execution' | 'hasWorker' | 'commands' | 'vmRecipes' | 'panels' | 'capabilities'
  >
): PluginConsentTier {
  switch (plugin.execution) {
    case 'trusted-worker':
      return 'worker'
    case 'instructional':
      return 'instructional'
    case 'sandboxed-ui':
      return 'panel'
    case 'data':
      return 'declarative'
    case undefined:
      break
  }
  // Why: older hosts omit `execution`, and their list hides some instructional points (agents),
  // so an unknown profile is never presented as content only.
  if (plugin.hasWorker) {
    return 'worker'
  }
  if (plugin.panels.length > 0 && plugin.commands.length === 0 && !plugin.vmRecipes?.length) {
    return 'panel'
  }
  return 'instructional'
}
