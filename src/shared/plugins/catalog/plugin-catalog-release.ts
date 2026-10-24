import { z } from 'zod'
import { pluginExecutionAllows, pluginExecutionProfileSchema } from '../plugin-execution-profile'
import {
  PLUGIN_CATALOG_TYPE_PROFILE,
  PLUGIN_CATALOG_TYPES,
  pluginCatalogTypes
} from './plugin-catalog-types'
import { PLUGIN_CAPABILITY_KINDS } from '../plugin-capabilities'
import {
  pluginContributionSummary,
  pluginContributionSummaryKey,
  pluginContributionSummarySchema
} from '../plugin-contribution-summary'
import { pluginCatalogReleaseDetailFields } from '../plugin-detail-fields'
import { pluginCatalogImagesSchema } from '../plugin-image-fields'
import { pluginFileTypeSchema } from '../plugin-file-type'
import type { PluginManifest } from '../manifest/plugin-manifest'
import { pluginFieldDoc, PLUGIN_MANIFEST_V2_SINCE } from '../manifest/plugin-schema-field-docs'

export {
  PLUGIN_CATALOG_TYPES,
  pluginCatalogReleaseTypes,
  pluginCatalogTypes,
  type PluginCatalogType
} from './plugin-catalog-types'

const NEXT = PLUGIN_MANIFEST_V2_SINCE

// Why hex only: these are painted directly, so anything that could carry url() or var() is out.
const hexColor = (description: string) =>
  z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb color')
    .meta(pluginFieldDoc(description, NEXT, ['#1b1430']))

/** The exact release a catalog vouches for. Unknown keys are stripped so a newer catalog
 *  can add optional fields without breaking clients that predate them. */
export const pluginCatalogReleaseSchema = z
  .object({
    version: z
      .string()
      .min(1)
      .max(128)
      .meta(pluginFieldDoc("The manifest's `version` for this release.", NEXT, ['1.2.0'])),
    // Why SHA-1 only: plugin materialization rejects SHA-256 repositories.
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'must be a full lowercase SHA-1 commit')
      .meta(pluginFieldDoc('Full SHA-1 commit Orca checks out for this release.', NEXT)),
    contentHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'must be a lowercase SHA-256 hex digest')
      .meta(
        pluginFieldDoc(
          "SHA-256 of the plugin's installed files, as Orca computes it at install.",
          NEXT
        )
      ),
    execution: pluginExecutionProfileSchema.meta(
      pluginFieldDoc("The manifest's `execution` profile.", NEXT, ['data'])
    ),
    minimumOrca: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, 'must be an x.y.z version')
      .meta(
        pluginFieldDoc(
          "The manifest's `engines.orca` without `>=`. Older Orca lists the plugin but will not install it.",
          NEXT,
          [NEXT]
        )
      ),
    types: z
      .array(z.enum(PLUGIN_CATALOG_TYPES))
      .min(1)
      .max(PLUGIN_CATALOG_TYPES.length)
      .refine((types) => new Set(types).size === types.length, 'duplicate contribution type')
      .optional()
      .meta({
        ...pluginFieldDoc(
          'Optional; Orca derives it from `contributes` and `execution`. When present, every kind of contribution the release carries, matching its manifest exactly. `instructions` needs the `declarative` profile or higher, `panel` needs `sandboxed-ui`, and `worker` needs `trusted-worker`.',
          NEXT,
          [['syntax']]
        ),
        uniqueItems: true
      }),
    name: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .meta(
        pluginFieldDoc(
          "The manifest's `name`, so Orca can suggest the plugin before downloading it.",
          NEXT,
          ['Gleam']
        )
      ),
    ...pluginCatalogReleaseDetailFields,
    images: pluginCatalogImagesSchema
      .optional()
      .catch(undefined)
      .meta(
        pluginFieldDoc(
          'Icon, cover and screenshots for the listing, shown before anything is downloaded.',
          NEXT
        )
      ),
    themePreview: z
      .array(
        z
          .strictObject({
            label: z
              .string()
              .min(1)
              .max(128)
              .meta(pluginFieldDoc('Theme name.', NEXT, ['Dusk'])),
            base: z.enum(['light', 'dark']).meta(pluginFieldDoc('Light or dark theme.', NEXT)),
            background: hexColor('Window background.'),
            foreground: hexColor('Main text.'),
            accent: hexColor('Accent, such as buttons.'),
            surface: hexColor('Cards and sidebars.')
          })
          .meta({
            id: 'CatalogThemePreview',
            description: 'Colors to draw a theme card before install.'
          })
      )
      .max(4)
      .optional()
      .catch(undefined)
      .meta(
        pluginFieldDoc(
          'Up to 4 theme palettes for listing art. Display only; the installed theme files decide the real colors.',
          NEXT
        )
      ),
    contributes: pluginContributionSummarySchema
      .optional()
      .catch(undefined)
      .meta(
        pluginFieldDoc(
          'What the release adds, as the listing shows it. Generate it with the catalog tooling; Orca refuses an install whose manifest says otherwise.',
          NEXT
        )
      ),
    capabilities: z
      .array(z.enum(PLUGIN_CAPABILITY_KINDS))
      .max(PLUGIN_CAPABILITY_KINDS.length)
      .optional()
      .catch(undefined)
      .meta(
        pluginFieldDoc(
          'Every capability the release asks for. Orca refuses an install whose manifest asks for different ones.',
          NEXT,
          [['notifications:show']]
        )
      ),
    /** Invalid entries are dropped, not fatal, so a newer catalog never hides the plugin. */
    fileTypes: z
      .array(pluginFileTypeSchema.optional().catch(undefined))
      .transform((entries) =>
        [...new Set(entries)].filter((entry): entry is string => entry !== undefined).slice(0, 32)
      )
      .optional()
      .meta(
        pluginFieldDoc(
          'Extensions, without the dot, that this release opens. Orca suggests the plugin when such a file has no viewer.',
          NEXT,
          [['gleam']]
        )
      )
  })
  .superRefine((release, ctx) => {
    for (const [index, type] of (release.types ?? []).entries()) {
      const required = PLUGIN_CATALOG_TYPE_PROFILE[type]
      if (required && !pluginExecutionAllows(release.execution, required)) {
        ctx.addIssue({
          code: 'custom',
          path: ['types', index],
          message: `${release.execution} cannot declare ${type}`
        })
      }
    }
  })
  .meta({
    id: 'CatalogRelease',
    description: 'The exact release the catalog vouches for. Orca refuses bytes that differ.'
  })

export type PluginCatalogRelease = z.infer<typeof pluginCatalogReleaseSchema>

/** The release entry a catalog should list for these exact bytes, so authors paste it instead of
 *  hand-copying fields that `pluginCatalogReleaseError` would refuse. */
export function pluginCatalogReleaseEntry(
  manifest: PluginManifest,
  pinned: { commit: string; contentHash: string }
): z.input<typeof pluginCatalogReleaseSchema> | null {
  if (manifest.manifestVersion !== 2) {
    return null
  }
  const fileTypes = [
    ...new Set(
      manifest.contributes.syntaxes.flatMap((syntax) =>
        syntax.extensions.map((extension) => extension.slice(1).toLowerCase())
      )
    )
  ]
  const capabilities = [...new Set(manifest.capabilities.map((capability) => capability.kind))]
  return {
    version: manifest.version,
    commit: pinned.commit,
    contentHash: pinned.contentHash,
    execution: manifest.execution,
    minimumOrca: manifest.engines.orca.replace(/^>=/, ''),
    name: manifest.name,
    contributes: pluginContributionSummary(manifest),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(fileTypes.length > 0 ? { fileTypes } : {})
  }
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
  if (
    release.types &&
    pluginCatalogTypes(manifest).sort().join() !== [...release.types].sort().join()
  ) {
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
  if (
    release.contributes &&
    pluginContributionSummaryKey(release.contributes) !==
      pluginContributionSummaryKey(pluginContributionSummary(manifest))
  ) {
    return 'the listed contributions do not match the catalog release'
  }
  const asked = [...new Set(manifest.capabilities.map((capability) => capability.kind))]
    .sort()
    .join()
  if (release.capabilities && [...new Set(release.capabilities)].sort().join() !== asked) {
    return 'the listed capabilities do not match the catalog release'
  }
  return null
}
