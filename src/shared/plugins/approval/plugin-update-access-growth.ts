import type { PluginManifest } from '../manifest/plugin-manifest'
import {
  canonicalizeCapability,
  type PluginCapabilityKind
} from '../capabilities/plugin-capabilities'
import {
  PLUGIN_CONTRIBUTION_POINT_POLICY,
  PLUGIN_CONTRIBUTION_POINTS,
  type PluginContributionPoint
} from '../contributions/plugin-contribution-points'
import {
  pluginExecutionAllows,
  pluginExecutionProfile,
  type PluginExecutionProfile
} from '../contributions/plugin-execution-profile'
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
    return JSON.stringify([field('id'), field('action'), field('when') ?? 'global'])
  }
  return JSON.stringify(entry)
}

type CustomEditorReach = {
  files: string[]
  takesDefault: boolean
  contentKind: string
}

function customEditorReach(entry: unknown): [string, CustomEditorReach] | null {
  if (!isPluginJsonObject(entry) || typeof entry.id !== 'string') {
    return null
  }
  return [
    entry.id,
    {
      files: (['extensions', 'filenames'] as const).flatMap((field) => {
        const list = entry[field]
        return Array.isArray(list)
          ? list.map((value) => `${field}:${String(value).toLowerCase()}`)
          : []
      }),
      takesDefault: entry.priority !== 'option',
      contentKind: typeof entry.contentKind === 'string' ? entry.contentKind : 'text'
    }
  ]
}

/** Why per field: new extensions or file names, or taking over opening them is more reach, while new editor
 *  code under the same id is not. */
function customEditorsGrow(installed: readonly unknown[], next: readonly unknown[]): boolean {
  const held = new Map(installed.map(customEditorReach).filter((reach) => reach !== null))
  return next.some((entry) => {
    const asked = customEditorReach(entry)
    const before = asked ? held.get(asked[0]) : undefined
    if (!asked || !before) {
      return true
    }
    const after = asked[1]
    return (
      after.files.some((file) => !before.files.includes(file)) ||
      (after.takesDefault && !before.takesDefault) ||
      after.contentKind !== before.contentKind
    )
  })
}

/** Each recipe's authority (id, checkout mode, commands) from its file; null when unreadable. */
export type PluginVmRecipeIdentities = readonly string[] | null

export function pluginUpdateAccessGrowth(
  installed: GrowthSubject,
  next: GrowthSubject,
  vmRecipes?: { installed: PluginVmRecipeIdentities; next: PluginVmRecipeIdentities }
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
    if (point === 'customEditors') {
      return customEditorsGrow(
        installed.contributes.customEditors ?? [],
        next.contributes.customEditors ?? []
      )
    }
    const before = new Set(
      (installed.contributes[point] ?? []).map((entry) => entryIdentity(point, entry))
    )
    // Why files: recipe command lines live there, not in the manifest; unread files always count.
    if (point === 'vmRecipes' && (next.contributes.vmRecipes?.length ?? 0) > 0) {
      const held = vmRecipes?.installed
      const asked = vmRecipes?.next
      return !held || !asked || asked.some((recipe) => !held.includes(recipe))
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
