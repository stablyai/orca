import { z } from 'zod'
import {
  pluginExecutionAllows,
  pluginExecutionProfileSchema,
  type PluginExecutionProfile
} from './plugin-execution-profile'
import { pluginFileTypeSchema } from './plugin-file-type'
import type { PluginManifest } from './plugin-manifest'

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
      .refine((types) => new Set(types).size === types.length, 'duplicate contribution type'),
    /** The plugin's name, so a suggestion can show it before anything is downloaded. */
    name: z.string().min(1).max(128).optional(),
    /** Extensions this release can open, for suggesting it when such a file has no viewer. Invalid
     *  entries are dropped, not fatal, so a newer catalog never hides the plugin. */
    fileTypes: z
      .array(z.unknown())
      .transform((entries) =>
        [...new Set(entries)]
          .filter((entry): entry is string => pluginFileTypeSchema.safeParse(entry).success)
          .slice(0, 32)
      )
      .optional()
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
  if (c.themes.length > 0) {
    types.push('app-theme')
  }
  if (c.terminalThemes.length > 0) {
    types.push('terminal-theme')
  }
  if (c.iconThemes.length > 0) {
    types.push('icon-theme')
  }
  if (c.syntaxes.length > 0) {
    types.push('syntax')
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
  // Why: a suggestion must lead to a plugin that really handles the file.
  const handled = new Set(
    manifest.contributes.syntaxes.flatMap((syntax) =>
      syntax.extensions.map((extension) => extension.slice(1).toLowerCase())
    )
  )
  if (release.name !== undefined && release.name !== manifest.name) {
    return 'plugin name does not match the catalog release'
  }
  if (release.fileTypes?.some((fileType) => !handled.has(fileType))) {
    return 'file types do not match the catalog release'
  }
  return null
}
