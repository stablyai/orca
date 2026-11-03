import { z } from 'zod'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import { pluginCatalogReleaseSchema, type PluginCatalogRelease } from './plugin-catalog-release'
import { satisfiesOrcaEngineRange } from '../manifest/plugin-manifest-engine-range'
import {
  catalogV2GitSourceSchema,
  marketplaceCategorySchema,
  marketplaceEntryFields,
  marketplaceHeaderFields,
  PLUGIN_MARKETPLACE_CATEGORY_LIMIT,
  PLUGIN_MARKETPLACE_ENTRY_LIMIT
} from './plugin-marketplace'
import {
  pluginFieldDoc,
  PLUGIN_DERIVED_PUBLISHER_SINCE,
  PLUGIN_MANIFEST_V2_SINCE
} from '../manifest/plugin-schema-field-docs'

/**
 * The plugin catalog (`orca-catalog.json`). The name never changes; `catalogVersion` does, and
 * only for a change older clients cannot ignore. Everything below is tolerant by design: a
 * catalog only lists, and installing re-checks the exact bytes, so an older client keeps
 * whatever it can understand instead of losing the whole catalog. CI and `validate` are the
 * strict checks.
 */
export const PLUGIN_CATALOG_FILENAME = 'orca-catalog.json'
export const PLUGIN_CATALOG_VERSION = 2
export const PLUGIN_CATALOG_RELEASE_LIMIT = 32

const NEXT = PLUGIN_MANIFEST_V2_SINCE

/** Keeps each valid item once, in order, up to `limit`; invalid items are dropped. */
function tolerantList<Item extends z.ZodType>(item: Item, limit: number) {
  return z
    .array(item.optional().catch(undefined))
    .transform((items) =>
      [...new Set(items)]
        .filter((value): value is NonNullable<z.output<Item>> => value !== undefined)
        .slice(0, limit)
    )
}

export const pluginCatalogEntrySchema = z
  .object({
    id: marketplaceEntryFields.id,
    source: catalogV2GitSourceSchema,
    ownerId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .catch(undefined)
      .meta(
        pluginFieldDoc(
          "GitHub's numeric id of the repository owner, recorded the first time the plugin was listed. Names can be renamed or re-registered; this id cannot. Informational: Orca does not read it yet, and older Orca ignores it.",
          PLUGIN_DERIVED_PUBLISHER_SINCE,
          [1_234_567]
        )
      ),
    description: safePluginDisplayText(z.string().min(1).max(4_096))
      .optional()
      .catch(undefined)
      .meta(pluginFieldDoc('Listing text shown in the catalog.', NEXT)),
    categories: tolerantList(marketplaceCategorySchema, PLUGIN_MARKETPLACE_CATEGORY_LIMIT)
      .default([])
      .meta({
        ...pluginFieldDoc(
          `Lowercase slugs used to filter the catalog, each listed once. At most ${PLUGIN_MARKETPLACE_CATEGORY_LIMIT}; extras are ignored.`,
          NEXT,
          [['themes']]
        ),
        uniqueItems: true,
        maxItems: PLUGIN_MARKETPLACE_CATEGORY_LIMIT
      }),
    releases: z
      .array(pluginCatalogReleaseSchema.optional().catch(undefined))
      .transform((releases) =>
        releases.filter((release) => release !== undefined).slice(0, PLUGIN_CATALOG_RELEASE_LIMIT)
      )
      .refine((releases) => releases.length > 0, 'needs at least one release this Orca can read')
      .meta({
        ...pluginFieldDoc(
          `Installable releases, newest first. Orca installs the first one whose \`minimumOrca\` it meets, so keep older releases listed when you raise \`engines.orca\`. At most ${PLUGIN_CATALOG_RELEASE_LIMIT}.`,
          NEXT
        ),
        minItems: 1,
        maxItems: PLUGIN_CATALOG_RELEASE_LIMIT
      })
  })
  .meta({ id: 'CatalogEntry', description: 'One installable plugin.' })

const catalogVersionSchema = z
  .literal(PLUGIN_CATALOG_VERSION)
  .meta(
    pluginFieldDoc(
      'Catalog format. Raised only for a change older Orca cannot ignore; a newer Orca reads this one.',
      NEXT
    )
  )

/** The catalog as authors write it; the published JSON Schema is generated from it. */
export const pluginCatalogDocumentSchema = z.object({
  $schema: z
    .string()
    .max(2048)
    .optional()
    .meta(pluginFieldDoc('JSON Schema URL for editor completion. Ignored by Orca.', NEXT)),
  catalogVersion: catalogVersionSchema,
  ...marketplaceHeaderFields,
  plugins: z
    .array(pluginCatalogEntrySchema)
    .max(PLUGIN_MARKETPLACE_ENTRY_LIMIT)
    .meta(
      pluginFieldDoc(
        `Listed plugins, at most ${PLUGIN_MARKETPLACE_ENTRY_LIMIT}. Each \`id\` should appear once; Orca keeps the first. An entry this Orca cannot read is skipped, never fatal.`,
        NEXT
      )
    )
})

function rawPluginId(entry: unknown): string | undefined {
  const id = typeof entry === 'object' && entry !== null && 'id' in entry ? entry.id : undefined
  return typeof id === 'string' ? id : undefined
}

/** Runtime parse of the same document: entries parse one by one, so one bad or newer entry
 *  never hides the rest; duplicates keep the first; the list is trimmed to the limit. */
export const pluginCatalogSchema = pluginCatalogDocumentSchema
  .omit({ $schema: true })
  .extend({ plugins: z.array(z.unknown()) })
  .transform((catalog) => {
    const seen = new Set<string>()
    const plugins = catalog.plugins.flatMap((raw) => {
      const id = rawPluginId(raw)
      if (id === undefined || seen.has(id) || seen.size >= PLUGIN_MARKETPLACE_ENTRY_LIMIT) {
        return []
      }
      const parsed = pluginCatalogEntrySchema.safeParse(raw)
      if (!parsed.success) {
        return []
      }
      seen.add(id)
      // Why dropped: listings are cached in a strict shape that older Orca reads back after a downgrade.
      const { ownerId: _ownerId, ...entry } = parsed.data
      return [entry]
    })
    return { ...catalog, plugins }
  })

/** Why before parsing: a newer format may change fields this build would misread, so refuse it
 *  with the fix instead of a list of schema errors. */
export function pluginCatalogVersionError(raw: unknown): string | null {
  const version =
    typeof raw === 'object' && raw !== null && 'catalogVersion' in raw ? raw.catalogVersion : null
  return typeof version === 'number' &&
    Number.isInteger(version) &&
    version > PLUGIN_CATALOG_VERSION
    ? `uses catalog format ${version}; update Orca to browse this catalog`
    : null
}

/** The release this host should offer: the first (newest) it can install, else the one needing
 *  the least newer Orca, so the listing can say "Needs Orca X" with the smallest X. */
export function selectPluginCatalogRelease(
  releases: readonly PluginCatalogRelease[],
  hostVersion: string
): PluginCatalogRelease | undefined {
  const installable = releases.find((release) =>
    satisfiesOrcaEngineRange(hostVersion, `>=${release.minimumOrca}`)
  )
  if (installable) {
    return installable
  }
  return [...releases].sort((a, b) =>
    satisfiesOrcaEngineRange(a.minimumOrca, `>=${b.minimumOrca}`) ? 1 : -1
  )[0]
}
