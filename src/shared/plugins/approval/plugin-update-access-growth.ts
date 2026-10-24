import type { PluginManifest } from '../manifest/plugin-manifest'
import { canonicalizeCapability, type PluginCapabilityKind } from '../plugin-capabilities'
import {
  PLUGIN_CONTRIBUTION_POINT_POLICY,
  PLUGIN_CONTRIBUTION_POINTS,
  type PluginContributionPoint
} from '../plugin-contribution-points'
import {
  pluginExecutionAllows,
  pluginExecutionProfile,
  type PluginExecutionProfile
} from '../plugin-execution-profile'
import { isPluginJsonObject } from '../manifest/plugin-json-object'

type GrowthSubject = Pick<PluginManifest, 'capabilities' | 'main' | 'contributes'> & {
  execution?: PluginExecutionProfile
}

/** What an update asks for beyond the installed version. Empty means it may keep its approval. */
export type PluginUpdateAccessGrowth = {
  capabilities: PluginCapabilityKind[]
  /** The new profile when it is above the installed one. */
  execution: PluginExecutionProfile | null
  /** Authority-bearing points that gained entries, e.g. a new global shortcut or panel. */
  contributions: PluginContributionPoint[]
}

// Why data points are excluded: themes, syntaxes and translations act on nothing.
const AUTHORITY_POINTS = PLUGIN_CONTRIBUTION_POINTS.filter(
  (point) => PLUGIN_CONTRIBUTION_POINT_POLICY[point].execution !== 'data'
)

/** What counts as the same entry. Why ids for panels: their code may change like any worker's;
 *  shortcuts, aliases and events count whole, since each part changes what they reach. */
function entryIdentity(point: PluginContributionPoint, entry: unknown): string {
  if (!isPluginJsonObject(entry)) {
    return JSON.stringify(entry)
  }
  if (point === 'panels' && 'id' in entry) {
    return `id:${String(entry.id)}`
  }
  if (point === 'commands') {
    const field = (key: string): unknown => (key in entry ? entry[key] : null)
    return JSON.stringify([field('id'), field('action'), field('context') ?? 'global'])
  }
  return JSON.stringify(entry)
}

export function pluginUpdateAccessGrowth(
  installed: GrowthSubject,
  next: GrowthSubject
): PluginUpdateAccessGrowth {
  // Why whole entries: a same-kind grant with a wider scope is still more access.
  const held = new Set(installed.capabilities.map(canonicalizeCapability))
  const capabilities = [
    ...new Set(
      next.capabilities
        .filter((capability) => !held.has(canonicalizeCapability(capability)))
        .map((capability) => capability.kind)
    )
  ]
  const nextExecution = pluginExecutionProfile(next)
  const execution = pluginExecutionAllows(pluginExecutionProfile(installed), nextExecution)
    ? null
    : nextExecution
  const contributions = AUTHORITY_POINTS.filter((point) => {
    const before = new Set(
      (installed.contributes[point] ?? []).map((entry) => entryIdentity(point, entry))
    )
    // Why recipes always count: their command lines live in files, not the manifest.
    if (point === 'vmRecipes' && (next.contributes.vmRecipes?.length ?? 0) > 0) {
      return true
    }
    return (next.contributes[point] ?? []).some((entry) => !before.has(entryIdentity(point, entry)))
  })
  return { capabilities, execution, contributions }
}

export function pluginUpdateGrowsAccess(growth: PluginUpdateAccessGrowth): boolean {
  return (
    growth.capabilities.length > 0 || growth.execution !== null || growth.contributions.length > 0
  )
}
