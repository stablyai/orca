import { z } from 'zod'
import { isAllowedPluginGitUrl } from '../plugin-install-lockfile'
import { isQualifiedPluginKey } from '../manifest/plugin-manifest'
import { pluginCatalogReleaseSchema } from './plugin-catalog-release'
import { pluginFieldDoc, PLUGIN_MANIFEST_V2_SINCE } from '../manifest/plugin-schema-field-docs'

const NEXT = PLUGIN_MANIFEST_V2_SINCE

// Why frozen: v1 entries are strict, so shipped clients reject any new field. New catalogs live
// in orca-catalog.json (plugin-catalog.ts); this file is generated from it for old clients.
export const PLUGIN_MARKETPLACE_FILENAME = 'orca-marketplace.json'
export const PLUGIN_MARKETPLACE_ENTRY_LIMIT = 2_048
export const PLUGIN_MARKETPLACE_CATEGORY_LIMIT = 16

export const OFFICIAL_PLUGIN_PUBLISHER = 'stablyai'
export const OFFICIAL_PLUGIN_ID_PREFIX = 'orca-'
export const OFFICIAL_MARKETPLACE_OWNER = 'stablyai'
export const OFFICIAL_MARKETPLACE_REPOSITORY = 'orca-plugins'

// Why: skill contributions are not supported, so a plugin declaring one fails to install.
// Shared catalogs this build does not control still list such packs; hide them so users never
// reach a dead install.
export const UNSUPPORTED_MARKETPLACE_CATEGORIES: readonly string[] = ['skills']

export function isMarketplaceListingSupported(categories: readonly string[]): boolean {
  return !categories.some((category) => UNSUPPORTED_MARKETPLACE_CATEGORIES.includes(category))
}

export const marketplaceOwnerSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/, 'invalid marketplace owner')

export const marketplaceCategorySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'categories must be lowercase slugs')

const gitSourceFields = {
  kind: z.literal('git').meta(pluginFieldDoc('Source kind. Only `git` is supported.', NEXT)),
  url: z
    .string()
    .trim()
    .min(1)
    .max(32 * 1024)
    .refine(isAllowedPluginGitUrl, 'git URL must use HTTPS or SSH')
    .meta(
      pluginFieldDoc('HTTPS or SSH URL of the plugin repository.', NEXT, [
        'https://github.com/acme/orca-gleam-syntax.git'
      ])
    ),
  // Why: marketplace installs must first resolve a named ref to an exact
  // commit; an omitted remote default would make the listing irreproducible.
  ref: z
    .string()
    .trim()
    .min(1)
    .max(4_096)
    .meta(
      pluginFieldDoc(
        'Branch or tag the author publishes from. Each release pins an exact commit.',
        NEXT,
        ['main']
      )
    )
}

export const pluginMarketplaceGitSourceSchema = z.strictObject(gitSourceFields)

// Why strip-unknown in v2: a later optional source field must not make older clients drop the entry.
export const catalogV2GitSourceSchema = z
  .object(gitSourceFields)
  .meta({ id: 'CatalogGitSource', description: 'Where the plugin source lives.' })

// Why regex then refine: the regex is the published `pattern`; the refine adds length and
// reserved-name rules without reporting a bad key twice.
const QUALIFIED_PLUGIN_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/

export const marketplaceEntryFields = {
  /** Canonical `<publisher>.<id>` identity expected in the source manifest. */
  id: z
    .string()
    .regex(QUALIFIED_PLUGIN_KEY_RE, 'invalid qualified plugin key')
    .refine(
      (key) => !QUALIFIED_PLUGIN_KEY_RE.test(key) || isQualifiedPluginKey(key),
      'invalid qualified plugin key'
    )
    .meta(
      pluginFieldDoc(
        "`<publisher>.<id>`, matching the plugin's manifest. Each half is at most 64 characters, and the reserved names `constructor` and `prototype` are refused.",
        NEXT,
        ['acme.gleam-syntax']
      )
    ),
  source: pluginMarketplaceGitSourceSchema,
  description: z
    .string()
    .min(1)
    .max(4_096)
    .optional()
    .meta(pluginFieldDoc('Listing text shown in the marketplace.', NEXT)),
  categories: z
    .array(marketplaceCategorySchema)
    .max(PLUGIN_MARKETPLACE_CATEGORY_LIMIT)
    .default([])
    .meta({
      ...pluginFieldDoc('Lowercase slugs used to filter the marketplace, each listed once.', NEXT, [
        ['themes']
      ]),
      uniqueItems: true
    })
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

/** Normalized entry held in memory and in the snapshot cache, from either catalog file. */
const pluginMarketplaceListingEntrySchema = z
  .strictObject({
    ...marketplaceEntryFields,
    releases: z.array(pluginCatalogReleaseSchema).min(1).optional()
  })
  .superRefine(rejectDuplicateCategories)

export const marketplaceHeaderFields = {
  name: z
    .string()
    .min(1)
    .max(256)
    .meta(pluginFieldDoc('Marketplace display name.', NEXT, ['Orca Plugins'])),
  owner: marketplaceOwnerSchema.meta(
    pluginFieldDoc('Account that publishes the marketplace.', NEXT, ['stablyai'])
  )
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
