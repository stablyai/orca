import { z } from 'zod'
import {
  pluginExecutionAllows,
  pluginExecutionProfileSchema,
  type PluginExecutionProfile
} from './plugin-execution-profile'
import type { PluginManifest } from './plugin-manifest'

// Why only installable types: a catalog entry naming any other type fails to parse, so the
// v2 catalog drops it instead of listing a plugin this client cannot install.
export const PLUGIN_CATALOG_TYPES = [
  'interface-language',
  'instructions',
  'panel',
  'worker'
] as const

export type PluginCatalogType = (typeof PLUGIN_CATALOG_TYPES)[number]

const CATALOG_TYPE_PROFILE: Partial<Record<PluginCatalogType, PluginExecutionProfile>> = {
  instructions: 'instructional',
  panel: 'sandboxed-ui',
  worker: 'trusted-worker'
}

/** The exact release a catalog vouches for. Unknown keys are stripped so a newer catalog
 *  can add optional fields without breaking clients that predate them. */
export const pluginCatalogReleaseSchema = z
  .object({
    version: z.string().min(1).max(128),
    // Why SHA-1 only: plugin materialization rejects SHA-256 repositories.
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    execution: pluginExecutionProfileSchema,
    minimumOrca: z.string().regex(/^\d+\.\d+\.\d+$/),
    types: z
      .array(z.enum(PLUGIN_CATALOG_TYPES))
      .min(1)
      .max(PLUGIN_CATALOG_TYPES.length)
      .refine((types) => new Set(types).size === types.length, 'duplicate contribution type')
  })
  .superRefine((release, ctx) => {
    for (const [index, type] of release.types.entries()) {
      const required = CATALOG_TYPE_PROFILE[type]
      if (required && !pluginExecutionAllows(release.execution, required)) {
        ctx.addIssue({
          code: 'custom',
          path: ['types', index],
          message: `${release.execution} cannot declare ${type}`
        })
      }
    }
  })

export type PluginCatalogRelease = z.infer<typeof pluginCatalogReleaseSchema>

export function pluginCatalogTypes(manifest: PluginManifest): PluginCatalogType[] {
  const c = manifest.contributes
  const types: PluginCatalogType[] = []
  if (c.languagePacks.length > 0) {
    types.push('interface-language')
  }
  if (c.commands.length || c.keybindings.length || c.vmRecipes.length || c.agents.length) {
    types.push('instructions')
  }
  if (c.panels.length > 0) {
    types.push('panel')
  }
  if (manifest.main !== undefined) {
    types.push('worker')
  }
  return types
}

/** Why null-or-message: install and preview surface the first mismatch verbatim. */
export function pluginCatalogReleaseError(input: {
  release: PluginCatalogRelease
  manifest: PluginManifest
  resolvedCommit: string | null
  contentHash: string
}): string | null {
  const { release, manifest } = input
  if (input.resolvedCommit !== release.commit) {
    return 'plugin source no longer matches the catalog release commit'
  }
  if (input.contentHash !== release.contentHash) {
    return 'plugin bytes do not match the catalog release'
  }
  if (manifest.manifestVersion !== 2) {
    return 'catalog releases require a version 2 manifest'
  }
  if (manifest.version !== release.version) {
    return 'manifest version does not match the catalog release'
  }
  if (manifest.execution !== release.execution) {
    return 'execution profile does not match the catalog release'
  }
  if (manifest.engines.orca !== `>=${release.minimumOrca}`) {
    return 'Orca compatibility does not match the catalog release'
  }
  const declared = [...release.types].sort().join()
  if (pluginCatalogTypes(manifest).sort().join() !== declared) {
    return 'contributions do not match the catalog release'
  }
  return null
}
