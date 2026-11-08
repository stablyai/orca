import {
  PLUGIN_CONTRIBUTION_POINT_POLICY,
  PLUGIN_CONTRIBUTION_POINTS
} from '../contributions/plugin-contribution-points'
import type { PluginContributionSummaryItem } from '../contributions/plugin-contribution-summary'
import type { PluginExecutionProfile } from '../contributions/plugin-execution-profile'
import type { PluginManifest } from '../manifest/plugin-manifest'

// Why only installable types: a catalog entry naming any other type fails to parse, so the
// v2 catalog drops it instead of listing a plugin this client cannot install.
export const PLUGIN_CATALOG_TYPES = [
  'interface-language',
  'app-theme',
  'terminal-theme',
  'icon-theme',
  'syntax',
  'instructions',
  'panel',
  'editor',
  'worker'
] as const

export type PluginCatalogType = (typeof PLUGIN_CATALOG_TYPES)[number]

export const PLUGIN_CATALOG_TYPE_PROFILE: Partial<
  Record<PluginCatalogType, PluginExecutionProfile>
> = {
  instructions: 'declarative',
  panel: 'sandboxed-ui',
  editor: 'sandboxed-ui',
  worker: 'trusted-worker'
}

export function pluginCatalogTypes(manifest: PluginManifest): PluginCatalogType[] {
  const declared = new Set<PluginCatalogType>()
  for (const point of PLUGIN_CONTRIBUTION_POINTS) {
    const type = PLUGIN_CONTRIBUTION_POINT_POLICY[point].catalogType
    if (type && manifest.contributes[point].length > 0) {
      declared.add(type)
    }
  }
  if (manifest.main !== undefined) {
    declared.add('worker')
  }
  return PLUGIN_CATALOG_TYPES.filter((type) => declared.has(type))
}

/** The release's types, derived from its summary and profile when the catalog leaves them out. */
export function pluginCatalogReleaseTypes(release: {
  types?: readonly PluginCatalogType[]
  contributes?: readonly Pick<PluginContributionSummaryItem, 'kind'>[]
  execution: PluginExecutionProfile
}): readonly PluginCatalogType[] {
  if (release.types) {
    return release.types
  }
  const declared = new Set<PluginCatalogType>()
  for (const item of release.contributes ?? []) {
    const type = PLUGIN_CONTRIBUTION_POINT_POLICY[item.kind].catalogType
    if (type) {
      declared.add(type)
    }
  }
  // Why: format 2 requires `main` for trusted-worker, and only it.
  if (release.execution === 'trusted-worker') {
    declared.add('worker')
  }
  return PLUGIN_CATALOG_TYPES.filter((type) => declared.has(type))
}
