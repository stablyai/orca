import { z } from 'zod'
import { pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import { readPluginImageHeader, type PluginImageInfo } from './plugin-image-format'
import {
  PLUGIN_IMAGE_RULES,
  pluginImageRuleError,
  pluginManifestImageFields,
  type PluginCatalogImages,
  type PluginImageKind
} from './plugin-image-fields'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

// Why loose: only the image fields matter here; full manifest checks run at install.
const manifestImagesSchema = lazyZodSchema(() =>
  z.object({
    name: z.string().optional(),
    icon: pluginRelativePathSchema.optional(),
    ...pluginManifestImageFields
  })
)

type CatalogImage = NonNullable<PluginCatalogImages['cover']>

/** Reads one repository file; null when missing or larger than `maxBytes`. */
export type PluginRepositoryFileReader = (
  path: string,
  maxBytes: number
) => Promise<Uint8Array | null>

/**
 * The catalog `images` for a plugin whose files live in the catalog repository, built from the
 * manifest's icon, cover and screenshots. `prefix` is the plugin's directory in that repository.
 * Images that are missing or break the image rules are left out.
 */
export async function catalogImagesFromManifest(input: {
  manifest: unknown
  prefix: string | undefined
  read: PluginRepositoryFileReader
  sha256: (bytes: Uint8Array) => string
  readHeader?: (bytes: Uint8Array) => PluginImageInfo | string
  maxTotalBytes?: number
}): Promise<PluginCatalogImages | null> {
  const parsed = manifestImagesSchema.safeParse(input.manifest)
  if (!parsed.success) {
    return null
  }
  let remaining = input.maxTotalBytes ?? Number.POSITIVE_INFINITY
  const seen = new Set<string>()
  const { name, icon, cover, screenshots } = parsed.data
  const image = async (
    kind: PluginImageKind,
    relative: string,
    alt: string
  ): Promise<CatalogImage | null> => {
    const maxBytes = Math.min(PLUGIN_IMAGE_RULES[kind].maxBytes, remaining)
    if (maxBytes <= 0) {
      return null
    }
    const path = input.prefix ? `${input.prefix}/${relative}` : relative
    const bytes = await input.read(path, maxBytes).catch(() => null)
    const info = bytes ? (input.readHeader ?? readPluginImageHeader)(bytes) : 'missing'
    if (!bytes || typeof info === 'string' || pluginImageRuleError(kind, info, bytes.byteLength)) {
      return null
    }
    const sha256 = input.sha256(bytes)
    if (!seen.has(sha256)) {
      seen.add(sha256)
      remaining = Math.max(0, remaining - bytes.byteLength)
    }
    return { path, alt, sha256, width: info.width, height: info.height }
  }
  const iconImage = icon ? await image('icon', icon, name ?? 'Plugin icon') : null
  const coverImage = cover ? await image('cover', cover.path, cover.alt) : null
  const shots: CatalogImage[] = []
  for (const shot of screenshots ?? []) {
    const shotImage = await image('screenshot', shot.path, shot.alt)
    if (shotImage) {
      shots.push(shotImage)
    }
  }
  const images: PluginCatalogImages = {
    ...(iconImage ? { icon: iconImage } : {}),
    ...(coverImage ? { cover: coverImage } : {}),
    ...(shots.length ? { screenshots: shots } : {})
  }
  return Object.keys(images).length ? images : null
}
