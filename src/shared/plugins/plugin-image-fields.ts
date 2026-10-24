import { z } from 'zod'
import { pluginRelativePathSchema } from './plugin-manifest-fields'
import type { PluginImageFormat, PluginImageInfo } from './plugin-image-format'
import {
  pluginFieldDoc,
  pluginPathFieldDoc,
  PLUGIN_MANIFEST_V2_SINCE
} from './plugin-schema-field-docs'

const NEXT = PLUGIN_MANIFEST_V2_SINCE

export type PluginImageKind = 'icon' | 'cover' | 'screenshot'

type PluginImageRule = {
  formats: readonly PluginImageFormat[]
  maxBytes: number
  minWidth: number
  minHeight: number
  square?: boolean
}

/** Per-kind limits. Why raster only: SVG can carry script and external fetches. */
export const PLUGIN_IMAGE_RULES: Record<PluginImageKind, PluginImageRule> = {
  icon: {
    formats: ['png', 'webp'],
    maxBytes: 256 * 1024,
    minWidth: 128,
    minHeight: 128,
    square: true
  },
  cover: { formats: ['png', 'jpeg', 'webp'], maxBytes: 1024 * 1024, minWidth: 800, minHeight: 500 },
  screenshot: {
    formats: ['png', 'jpeg', 'webp'],
    maxBytes: 1536 * 1024,
    minWidth: 1280,
    minHeight: 800
  }
}
export const PLUGIN_SCREENSHOT_LIMIT = 6
export const PLUGIN_IMAGES_TOTAL_MAX_BYTES = 8 * 1024 * 1024

/** Null when an image fits its kind, else why not. */
export function pluginImageRuleError(
  kind: PluginImageKind,
  info: PluginImageInfo,
  bytes: number
): string | null {
  const rule = PLUGIN_IMAGE_RULES[kind]
  if (!rule.formats.includes(info.format)) {
    return `${kind} must be ${rule.formats.map((format) => format.toUpperCase()).join(' or ')}`
  }
  if (bytes > rule.maxBytes) {
    return `${kind} must be at most ${Math.round(rule.maxBytes / 1024)} KB`
  }
  if (info.width < rule.minWidth || info.height < rule.minHeight) {
    return `${kind} must be at least ${rule.minWidth}×${rule.minHeight}`
  }
  if (rule.square && info.width !== info.height) {
    return `${kind} must be square`
  }
  return null
}

const altSchema = z
  .string()
  .min(1)
  .max(160)
  .meta(
    pluginFieldDoc('What the image shows, for screen readers. Required.', NEXT, [
      'The Dusk theme on a terminal'
    ])
  )

const imageRuleText = (kind: PluginImageKind): string => {
  const rule = PLUGIN_IMAGE_RULES[kind]
  return `${rule.formats.join(', ').toUpperCase()}, static, at least ${rule.minWidth}×${rule.minHeight}${rule.square ? ', square' : ''}, at most ${Math.round(rule.maxBytes / 1024)} KB.`
}

/** Manifest image fields: files in the package, so the content hash covers them. */
export const pluginManifestImageFields = {
  cover: z
    .strictObject({
      path: pluginRelativePathSchema.meta(
        pluginPathFieldDoc(
          `Cover image shown on the plugin page, 16:10 recommended (1600×1000). ${imageRuleText('cover')}`,
          NEXT,
          ['images/cover.png']
        )
      ),
      alt: altSchema
    })
    .optional()
    .meta(pluginFieldDoc('Wide image at the top of the plugin page.', NEXT)),
  screenshots: z
    .array(
      z
        .strictObject({
          path: pluginRelativePathSchema.meta(
            pluginPathFieldDoc(
              `Screenshot, 16:10 recommended (up to 2560×1600). ${imageRuleText('screenshot')}`,
              NEXT,
              ['images/editor.png']
            )
          ),
          alt: altSchema,
          caption: z
            .string()
            .min(1)
            .max(120)
            .optional()
            .meta(
              pluginFieldDoc('Short caption under the screenshot.', NEXT, ['Gleam in the editor'])
            ),
          theme: z
            .enum(['light', 'dark'])
            .optional()
            .meta(
              pluginFieldDoc('Show this screenshot only with a light or dark Orca theme.', NEXT)
            )
        })
        .meta({ id: 'Screenshot', description: 'One screenshot of the plugin in use.' })
    )
    .max(PLUGIN_SCREENSHOT_LIMIT)
    .optional()
    .meta(
      pluginFieldDoc(
        `Screenshots for the plugin page, at most ${PLUGIN_SCREENSHOT_LIMIT}. All images together may be at most ${PLUGIN_IMAGES_TOTAL_MAX_BYTES / 1024 / 1024} MB.`,
        NEXT
      )
    )
}

export const PLUGIN_ICON_RULE_TEXT = imageRuleText('icon')

/** A catalog image: a file in the catalog repository at the vouched catalog commit, pinned by
 *  hash, so a listing shows it before any plugin is downloaded and nothing is hotlinked. */
const catalogImageSchema = z
  .strictObject({
    path: pluginRelativePathSchema.meta(
      pluginPathFieldDoc('File in the catalog repository, relative to its root.', NEXT, [
        'assets/acme.gleam/cover.png'
      ])
    ),
    alt: altSchema,
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'must be a lowercase SHA-256 hex digest')
      .meta(pluginFieldDoc("SHA-256 of the file's bytes; Orca refuses bytes that differ.", NEXT)),
    width: z
      .number()
      .int()
      .min(1)
      .max(4096)
      .meta(pluginFieldDoc('Width in pixels.', NEXT, [1600])),
    height: z
      .number()
      .int()
      .min(1)
      .max(4096)
      .meta(pluginFieldDoc('Height in pixels.', NEXT, [1000]))
  })
  .meta({ id: 'CatalogImage', description: 'An image stored in the catalog repository.' })

export const pluginCatalogImagesSchema = z
  .strictObject({
    icon: catalogImageSchema.optional(),
    cover: catalogImageSchema.optional(),
    screenshots: z
      .array(catalogImageSchema)
      .max(PLUGIN_SCREENSHOT_LIMIT)
      .optional()
      .meta(pluginFieldDoc(`Screenshots, at most ${PLUGIN_SCREENSHOT_LIMIT}.`, NEXT))
  })
  .meta({
    id: 'CatalogImages',
    description: `Images extracted from the release by catalog CI, which re-encodes them and strips metadata. Same rules as the manifest: icon ${imageRuleText('icon')} Cover ${imageRuleText('cover')} Screenshots ${imageRuleText('screenshot')} Images must not imitate Orca's trust badges.`
  })

export type PluginCatalogImages = z.infer<typeof pluginCatalogImagesSchema>
