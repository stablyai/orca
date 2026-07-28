import { z } from 'zod'
import { isAllowedPluginGitUrl } from './plugin-install-lockfile'
import { isQualifiedPluginKey } from './plugin-manifest'

export const PLUGIN_MARKETPLACE_FILENAME = 'orca-marketplace.json'
export const PLUGIN_MARKETPLACE_ENTRY_LIMIT = 2_048
export const PLUGIN_MARKETPLACE_CATEGORY_LIMIT = 16

export const OFFICIAL_PLUGIN_PUBLISHER = 'stablyai'
export const OFFICIAL_PLUGIN_ID_PREFIX = 'orca-'
export const OFFICIAL_MARKETPLACE_OWNER = 'stablyai'
export const OFFICIAL_MARKETPLACE_REPOSITORY = 'orca-plugins'

// Why: skill contributions were dropped, so `contributes` now rejects them and
// any plugin declaring one fails to install wholesale. The shared marketplace
// index (which this build does not control) still advertises such packs; hide
// listings that carry these categories so users never hit a dead "install" path
// until the marketplace catches up.
export const UNSUPPORTED_MARKETPLACE_CATEGORIES: readonly string[] = ['skills']

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
  // Why: marketplace installs must first resolve a named ref to an exact
  // commit; an omitted remote default would make the listing irreproducible.
  ref: z.string().trim().min(1).max(4_096)
})

export const pluginMarketplaceEntrySchema = z
  .strictObject({
    /** Canonical `<publisher>.<id>` identity expected in the source manifest. */
    id: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
    source: pluginMarketplaceGitSourceSchema,
    description: z.string().min(1).max(4_096).optional(),
    categories: z
      .array(marketplaceCategorySchema)
      .max(PLUGIN_MARKETPLACE_CATEGORY_LIMIT)
      .default([])
  })
  .superRefine((entry, context) => {
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
  })

export const pluginMarketplaceSchema = z
  .strictObject({
    name: z.string().min(1).max(256),
    owner: marketplaceOwnerSchema,
    plugins: z.array(pluginMarketplaceEntrySchema).max(PLUGIN_MARKETPLACE_ENTRY_LIMIT)
  })
  .superRefine((marketplace, context) => {
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
  })

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

export type PluginMarketplace = z.infer<typeof pluginMarketplaceSchema>
export type PluginMarketplaceEntry = z.infer<typeof pluginMarketplaceEntrySchema>
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
