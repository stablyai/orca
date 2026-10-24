import {
  PLUGIN_CATALOG_FILENAME,
  pluginCatalogEntrySchema,
  pluginCatalogSchema,
  pluginCatalogVersionError
} from './plugin-catalog'
import { PLUGIN_MANIFEST_FILENAME, parsePluginManifest } from './plugin-manifest'
import { PLUGIN_MARKETPLACE_ENTRY_LIMIT } from './plugin-marketplace'
import { readPluginImageHeader } from './plugin-image-format'
import {
  pluginImageRuleError,
  type PluginCatalogImages,
  type PluginImageKind
} from './plugin-image-fields'
import { formatPluginSchemaIssues } from './plugin-schema-issues'

/**
 * Strict checks for authors and catalog CI. The runtime reads catalogs tolerantly (skipping,
 * trimming, keeping the first duplicate) so a mistake never hides other plugins; here every one
 * of those repairs is an error, so it is fixed before it ships.
 */
/** Reads a file relative to the catalog repository root, with its SHA-256; null when missing. */
export type PluginCatalogFileReader = (path: string) => { bytes: Uint8Array; sha256: string } | null

export function validatePluginFile(
  fileName: string,
  raw: unknown,
  readCatalogFile?: PluginCatalogFileReader
): string[] {
  if (fileName === PLUGIN_MANIFEST_FILENAME) {
    const parsed = parsePluginManifest(raw)
    return parsed.ok ? [] : [parsed.error]
  }
  if (fileName === PLUGIN_CATALOG_FILENAME) {
    return validatePluginCatalog(raw, readCatalogFile)
  }
  return [
    `unknown plugin file ${fileName}; expected ${PLUGIN_MANIFEST_FILENAME} or ${PLUGIN_CATALOG_FILENAME}`
  ]
}

function validatePluginCatalog(raw: unknown, readCatalogFile?: PluginCatalogFileReader): string[] {
  const tooNew = pluginCatalogVersionError(raw)
  if (tooNew) {
    return [tooNew]
  }
  const parsed = pluginCatalogSchema.safeParse(raw)
  if (!parsed.success) {
    return [formatPluginSchemaIssues(parsed.error.issues, raw)]
  }
  const entries: unknown[] =
    typeof raw === 'object' && raw !== null && 'plugins' in raw && Array.isArray(raw.plugins)
      ? raw.plugins
      : []
  const errors: string[] = []
  if (entries.length > PLUGIN_MARKETPLACE_ENTRY_LIMIT) {
    errors.push(`plugins: must be at most ${PLUGIN_MARKETPLACE_ENTRY_LIMIT} items`)
  }
  const seen = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    const at = `plugins[${index}]`
    const result = pluginCatalogEntrySchema.safeParse(entry)
    if (!result.success) {
      errors.push(`${at}: ${formatPluginSchemaIssues(result.error.issues, entry)}`)
      continue
    }
    if (seen.has(result.data.id)) {
      errors.push(`${at}.id: duplicate plugin id ${result.data.id}`)
    }
    seen.add(result.data.id)
    // Why compare counts: the entry schema silently drops what it cannot read.
    const rawEntry = typeof entry === 'object' && entry !== null ? entry : {}
    const rawReleases =
      'releases' in rawEntry && Array.isArray(rawEntry.releases) ? rawEntry.releases : []
    if (rawReleases.length !== result.data.releases.length) {
      errors.push(
        `${at}.releases: ${rawReleases.length - result.data.releases.length} release(s) are unreadable or over the limit`
      )
    }
    const rawCategories =
      'categories' in rawEntry && Array.isArray(rawEntry.categories) ? rawEntry.categories : []
    if (rawCategories.length !== result.data.categories.length) {
      errors.push(`${at}.categories: has invalid, repeated or extra categories`)
    }
    if (
      'description' in rawEntry &&
      rawEntry.description !== undefined &&
      result.data.description === undefined
    ) {
      errors.push(`${at}.description: must be text of 1 to 4096 characters`)
    }
    for (const [releaseIndex, release] of result.data.releases.entries()) {
      const rawRelease: unknown = rawReleases[releaseIndex]
      if (
        typeof rawRelease === 'object' &&
        rawRelease !== null &&
        'images' in rawRelease &&
        release.images === undefined
      ) {
        errors.push(`${at}.releases[${releaseIndex}].images: is not a valid image set`)
      }
      if (release.images && readCatalogFile) {
        errors.push(
          ...catalogImageErrors(release.images, readCatalogFile).map(
            (error) => `${at}.releases[${releaseIndex}].images.${error}`
          )
        )
      }
    }
  }
  return errors
}

function catalogImageErrors(
  images: PluginCatalogImages,
  readCatalogFile: PluginCatalogFileReader
): string[] {
  const entries: [string, PluginImageKind, PluginCatalogImages['cover']][] = [
    ['icon', 'icon', images.icon],
    ['cover', 'cover', images.cover],
    ...(images.screenshots ?? []).map(
      (shot, index): [string, PluginImageKind, PluginCatalogImages['cover']] => [
        `screenshots[${index}]`,
        'screenshot',
        shot
      ]
    )
  ]
  return entries.flatMap(([at, kind, image]) => {
    if (!image) {
      return []
    }
    const file = readCatalogFile(image.path)
    if (!file) {
      return [`${at}: ${image.path} is missing from the catalog repository`]
    }
    if (file.sha256 !== image.sha256) {
      return [`${at}: sha256 does not match ${image.path}`]
    }
    const info = readPluginImageHeader(file.bytes)
    if (typeof info === 'string') {
      return [`${at}: ${info}`]
    }
    if (info.width !== image.width || info.height !== image.height) {
      return [`${at}: is ${info.width}×${info.height}, not ${image.width}×${image.height}`]
    }
    const ruleError = pluginImageRuleError(kind, info, file.bytes.byteLength)
    return ruleError ? [`${at}: ${ruleError}`] : []
  })
}
