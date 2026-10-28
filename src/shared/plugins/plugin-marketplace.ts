import { z } from 'zod'
import { isAllowedPluginGitUrl } from './plugin-install-lockfile'
import { isQualifiedPluginKey } from './plugin-manifest'
import { pluginCatalogReleaseSchema } from './plugin-catalog-release'

export const PLUGIN_MARKETPLACE_FILENAME = 'orca-marketplace.json'
// Why a second file: v1 entries are strict, so shipped clients reject any new field.
// Release-bearing entries live here and the v1 file stays frozen for those clients.
export const PLUGIN_MARKETPLACE_V2_FILENAME = 'orca-marketplace.v2.json'
export const PLUGIN_MARKETPLACE_ENTRY_LIMIT = 2_048
export const PLUGIN_MARKETPLACE_CATEGORY_LIMIT = 16

export const OFFICIAL_PLUGIN_PUBLISHER = 'stablyai'
export const OFFICIAL_PLUGIN_ID_PREFIX = 'orca-'
export const OFFICIAL_MARKETPLACE_OWNER = 'stablyai'
export const OFFICIAL_MARKETPLACE_REPOSITORY = 'orca-plugins'

// Hide unsupported contribution categories still advertised by the externally maintained index; otherwise their manifests
// fail wholesale and present a dead install path until the marketplace catches up.
export const UNSUPPORTED_MARKETPLACE_CATEGORIES: readonly string[] = [
  'themes',
  'icons',
  'icon-themes',
  'terminal-themes',
  'skills'
]

export function isMarketplaceListingSupported(categories: readonly string[]): boolean {
  return !categories.some((category) => UNSUPPORTED_MARKETPLACE_CATEGORIES.includes(category))
}

const marketplaceOwnerSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/, 'invalid marketplace owner')

const marketplaceCategorySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'categories must be lowercase slugs')

export const pluginMarketplaceGitSourceSchema = z.strictObject({
  kind: z.literal('git'),
  url: z
    .string()
    .trim()
    .min(1)
    .max(32 * 1024)
    .refine(isAllowedPluginGitUrl, 'git URL must use HTTPS or SSH'),
  // Require a named ref before resolving the exact commit; unspecified remote defaults are not reproducible listings.
  ref: z.string().trim().min(1).max(4_096)
})

const marketplaceEntryFields = {
  /** Canonical `<publisher>.<id>` identity expected in the source manifest. */
  id: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  source: pluginMarketplaceGitSourceSchema,
  description: z.string().min(1).max(4_096).optional(),
  categories: z.array(marketplaceCategorySchema).max(PLUGIN_MARKETPLACE_CATEGORY_LIMIT).default([])
}

function rejectDuplicateCategories(
  entry: { categories: string[] },
  context: z.RefinementCtx
): void {
  const seen = new Set<string>()
  for (const [index, category] of entry.categories.entries()) {
    if (seen.has(category)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['categories', index],
        message: `duplicate category: ${category}`
      })
    }
    seen.add(category)
  }
}

function rejectDuplicatePluginIds(
  marketplace: { plugins: { id: string }[] },
  context: z.RefinementCtx
): void {
  const seen = new Set<string>()
  for (const [index, plugin] of marketplace.plugins.entries()) {
    if (seen.has(plugin.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['plugins', index, 'id'],
        message: `duplicate plugin id: ${plugin.id}`
      })
    }
    seen.add(plugin.id)
  }
}

export const pluginMarketplaceEntrySchema = z
  .strictObject(marketplaceEntryFields)
  .superRefine(rejectDuplicateCategories)

/** v2 entries strip unknown keys so later optional fields reach older clients safely. */
const pluginMarketplaceV2EntrySchema = z
  .object({ ...marketplaceEntryFields, release: pluginCatalogReleaseSchema })
  .superRefine(rejectDuplicateCategories)

/** Normalized entry held in memory and in the snapshot cache, from either catalog file. */
const pluginMarketplaceListingEntrySchema = z
  .strictObject({ ...marketplaceEntryFields, release: pluginCatalogReleaseSchema.optional() })
  .superRefine(rejectDuplicateCategories)

const marketplaceHeaderFields = {
  name: z.string().min(1).max(256),
  owner: marketplaceOwnerSchema
}

export const pluginMarketplaceSchema = z
  .strictObject({
    ...marketplaceHeaderFields,
    plugins: z.array(pluginMarketplaceEntrySchema).max(PLUGIN_MARKETPLACE_ENTRY_LIMIT)
  })
  .superRefine(rejectDuplicatePluginIds)

export const pluginMarketplaceListingSchema = z
  .strictObject({
    ...marketplaceHeaderFields,
    plugins: z.array(pluginMarketplaceListingEntrySchema).max(PLUGIN_MARKETPLACE_ENTRY_LIMIT)
  })
  .superRefine(rejectDuplicatePluginIds)

/** Why entries parse one by one: an entry this client cannot install (a newer contribution
 *  type) is skipped instead of hiding every other plugin in the catalog. Duplicate ids are
 *  still checked across every raw entry, matching the v1 rule. */
export const pluginMarketplaceV2Schema = z
  .object({
    ...marketplaceHeaderFields,
    plugins: z.array(z.unknown()).max(PLUGIN_MARKETPLACE_ENTRY_LIMIT)
  })
  .superRefine((catalog, context) =>
    rejectDuplicatePluginIds({ plugins: catalog.plugins.map(rawPluginIdentity) }, context)
  )
  .transform((catalog) => ({
    ...catalog,
    plugins: catalog.plugins.flatMap((entry) => {
      const parsed = pluginMarketplaceV2EntrySchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    })
  }))

function rawPluginIdentity(entry: unknown, index: number): { id: string } {
  const id = typeof entry === 'object' && entry !== null && 'id' in entry ? entry.id : undefined
  // Why the NUL placeholder: entries without a string id can never collide with each other.
  return { id: typeof id === 'string' ? id : `\0${index}` }
}

/** Host-derived trust metadata. Marketplace JSON cannot self-award either bit. */
export const pluginMarketplaceTrustMetadataSchema = z
  .strictObject({
    official: z.boolean(),
    bundled: z.boolean()
  })
  .refine((metadata) => !metadata.bundled || metadata.official, {
    message: 'bundled plugins must be official',
    path: ['bundled']
  })

export type PluginMarketplace = z.infer<typeof pluginMarketplaceListingSchema>
export type PluginMarketplaceEntry = z.infer<typeof pluginMarketplaceListingEntrySchema>
export type PluginMarketplaceGitSource = z.infer<typeof pluginMarketplaceGitSourceSchema>
export type PluginMarketplaceTrustMetadata = z.infer<typeof pluginMarketplaceTrustMetadataSchema>

export const OFFICIAL_MARKETPLACE_GIT_SOURCE: PluginMarketplaceGitSource = {
  kind: 'git',
  url: 'https://github.com/stablyai/orca-plugins.git',
  ref: 'main'
}

export function splitQualifiedPluginKey(pluginKey: string): {
  publisher: string
  id: string
} | null {
  if (!isQualifiedPluginKey(pluginKey)) {
    return null
  }
  const separator = pluginKey.indexOf('.')
  return {
    publisher: pluginKey.slice(0, separator),
    id: pluginKey.slice(separator + 1)
  }
}

export function isReservedPluginIdentity(pluginKey: string): boolean {
  const identity = splitQualifiedPluginKey(pluginKey)
  return (
    identity !== null &&
    (identity.publisher === OFFICIAL_PLUGIN_PUBLISHER ||
      identity.id.startsWith(OFFICIAL_PLUGIN_ID_PREFIX))
  )
}

export function isOfficialPluginIdentity(pluginKey: string): boolean {
  const identity = splitQualifiedPluginKey(pluginKey)
  return (
    identity !== null &&
    identity.publisher === OFFICIAL_PLUGIN_PUBLISHER &&
    identity.id.startsWith(OFFICIAL_PLUGIN_ID_PREFIX)
  )
}

type GitRepositoryIdentity = {
  host: string
  owner: string
  repository: string
}

/** Extracts the host and first owner segment from the HTTPS/SSH Git forms the
 * installer accepts. It is intentionally only a provenance parser. */
export function parseGitRepositoryIdentity(url: string): GitRepositoryIdentity | null {
  const trimmed = url.trim()
  const scp = /^[^\s@/:]+@([^\s:]+):(.+)$/.exec(trimmed)
  if (scp) {
    return repositoryIdentity(scp[1]!, scp[2]!)
  }
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
      return null
    }
    return repositoryIdentity(parsed.hostname, parsed.pathname)
  } catch {
    return null
  }
}

function repositoryIdentity(host: string, repositoryPath: string): GitRepositoryIdentity | null {
  const segments = repositoryPath
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
  if (segments.length < 2) {
    return null
  }
  const repository = segments.at(-1)!.replace(/\.git$/i, '')
  if (!repository) {
    return null
  }
  return { host: host.toLowerCase(), owner: segments[0]!, repository }
}

export function isOfficialOrganizationGitSource(url: string): boolean {
  const source = parseGitRepositoryIdentity(url)
  return source?.host === 'github.com' && source.owner.toLowerCase() === OFFICIAL_PLUGIN_PUBLISHER
}

export function isOfficialMarketplaceGitSource(url: string): boolean {
  const source = parseGitRepositoryIdentity(url)
  return (
    source?.host === 'github.com' &&
    source.owner.toLowerCase() === OFFICIAL_MARKETPLACE_OWNER &&
    source.repository.toLowerCase() === OFFICIAL_MARKETPLACE_REPOSITORY
  )
}
