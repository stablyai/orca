import type {
  PluginHostListEntry,
  PluginMarketplaceHostListing
} from '../../../../../preload/api-types'
import {
  pluginExecutionProfile,
  type PluginExecutionProfile
} from '../../../../../shared/plugins/plugin-execution-profile'
import type { PluginManifest } from '../../../../../shared/plugins/manifest/plugin-manifest'
import {
  PLUGIN_CONTRIBUTION_POINT_POLICY,
  PLUGIN_CONTRIBUTION_POINTS,
  type PluginContributionPoint
} from '../../../../../shared/plugins/plugin-contribution-points'

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

/** What a review must warn about. Each flag is the union of the verified profile and what the
 *  plugin contributes, so a profile never hides a lower-tier contribution it also carries. */
export type PluginTrust = {
  /** Its own process with full access. */
  worker: boolean
  /** Commands, shortcuts, recipes or agent instructions that act under your authority. */
  declarative: boolean
  /** A sandboxed panel; bounded by its capabilities. */
  panel: boolean
}

/** Contribution points a plugin is known to use; null when nothing verified says yet. */
export type PluginKnownPoints = ReadonlySet<PluginContributionPoint> | null

export function pluginPointsFromManifest(manifest: PluginManifest): Set<PluginContributionPoint> {
  return new Set(
    PLUGIN_CONTRIBUTION_POINTS.filter((point) => manifest.contributes[point].length > 0)
  )
}

/** Points from a catalog summary, which install checks against the manifest. */
export function pluginPointsFromSummary(
  summary: readonly { kind: PluginContributionPoint }[]
): Set<PluginContributionPoint> {
  return new Set(summary.map((item) => item.kind))
}

function usesProfile(points: PluginKnownPoints, profile: PluginExecutionProfile): boolean | null {
  return points
    ? [...points].some((point) => PLUGIN_CONTRIBUTION_POINT_POLICY[point].execution === profile)
    : null
}

/**
 * Why over-warn when unknown: a profile allows everything below it, and an older host's list
 * hides some declarative points (agents), so only known-absent contributions drop a warning.
 */
export function pluginTrust({
  execution,
  points,
  hasWorker = false
}: {
  execution: PluginExecutionProfile | null
  points: PluginKnownPoints
  hasWorker?: boolean
}): PluginTrust {
  if (execution === 'data') {
    return { worker: false, declarative: false, panel: false }
  }
  const worker =
    execution === 'trusted-worker' || hasWorker || usesProfile(points, 'trusted-worker') === true
  const declarative = execution === 'declarative' || (usesProfile(points, 'declarative') ?? true)
  const panel = execution === 'sandboxed-ui' || points?.has('panels') === true
  return { worker, declarative, panel }
}

/** An installed plugin's trust, from its manifest once read, else what its list entry shows. */
export function installedPluginTrust(
  plugin: Pick<PluginHostListEntry, 'execution' | 'hasWorker' | 'panels'>,
  manifest: PluginManifest | null | undefined
): PluginTrust {
  return pluginTrust({
    execution: plugin.execution ?? null,
    // Why not the list's commands: it omits agents, so only the manifest can rule them out.
    points: manifest ? pluginPointsFromManifest(manifest) : null,
    hasWorker: plugin.hasWorker
  })
}
