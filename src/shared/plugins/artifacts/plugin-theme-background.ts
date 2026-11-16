import { z } from 'zod'
import { pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import {
  PLUGIN_MANIFEST_V2_SINCE,
  PLUGIN_THEME_GLASS_SINCE,
  PLUGIN_THEME_VIDEO_BACKGROUND_SINCE,
  pluginFieldDoc,
  pluginPathFieldDoc
} from '../manifest/plugin-schema-field-docs'
import { PLUGIN_THEME_BACKGROUND_RULE_TEXT } from '../images/plugin-image-fields'
import { PLUGIN_THEME_VIDEO_RULE_TEXT } from '../media/plugin-theme-video-rules'
import { parsePluginImageUrl } from '../images/plugin-image-url'

const NEXT = PLUGIN_MANIFEST_V2_SINCE

const backgroundStyleFields = {
  opacity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .meta(
      pluginFieldDoc(
        'How strongly the image shows over the theme background, 0 to 1. Defaults to 1.',
        NEXT,
        [0.35]
      )
    ),
  size: z
    .enum(['cover', 'contain', 'tile'])
    .optional()
    .meta(pluginFieldDoc('How the image fills the window. Defaults to `cover`.', NEXT)),
  position: z
    .enum(['center', 'top', 'bottom', 'left', 'right'])
    .optional()
    .meta(pluginFieldDoc('Which edge the image anchors to. Defaults to `center`.', NEXT))
}

/** Default share of the chrome color over the blurred image. */
export const PLUGIN_THEME_GLASS_DEFAULT_TINT = 0.75

const glassTintSchema = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .meta(
    pluginFieldDoc(
      `How much of each surface's own color covers the blurred image, 0 to 1. Defaults to ${PLUGIN_THEME_GLASS_DEFAULT_TINT}. Orca raises it when the theme's text would otherwise read worse than its contrast rules allow.`,
      PLUGIN_THEME_GLASS_SINCE,
      [0.8]
    )
  )

const glassDescription = `Paints the sidebars, tab bars, title bar and status bar with \`path\` blurred once, under each surface's own color. Terminals, editors and chats are unchanged. Off when the theme has a \`videoPath\`, under Reduce Visual Effects or reduced transparency, and in releases before ${PLUGIN_THEME_GLASS_SINCE}.`

const backgroundFields = {
  path: pluginRelativePathSchema.meta(
    pluginPathFieldDoc(`Image file in the plugin. ${PLUGIN_THEME_BACKGROUND_RULE_TEXT}`, NEXT, [
      'images/dusk.webp'
    ])
  ),
  videoPath: pluginRelativePathSchema
    .optional()
    .meta(
      pluginPathFieldDoc(
        `Looping video played over \`path\` while the window is focused and motion is not reduced; only \`path\` shows otherwise, when the video cannot play, and in releases before ${PLUGIN_THEME_VIDEO_BACKGROUND_SINCE}. ${PLUGIN_THEME_VIDEO_RULE_TEXT}`,
        PLUGIN_THEME_VIDEO_BACKGROUND_SINCE,
        ['images/dusk.mp4']
      )
    ),
  ...backgroundStyleFields,
  glass: z
    .strictObject({ tint: glassTintSchema })
    .optional()
    .meta(pluginFieldDoc(glassDescription, PLUGIN_THEME_GLASS_SINCE, [{ tint: 0.8 }]))
}

// Why per-field catch: a glass option added later must not turn glass off.
const tolerantGlassSchema = z
  .object({ tint: glassTintSchema.catch(undefined) })
  .optional()
  .catch(undefined)

/** `validate:plugin` shape: unknown keys fail authoring. */
export const pluginThemeBackgroundSchema = z
  .strictObject(backgroundFields)
  .meta(
    pluginFieldDoc(
      'One image painted under translucent terminals and chats (Background Opacity below 1). Never blurred live; `glass` paints a copy blurred once on the window chrome.',
      NEXT
    )
  )

export type PluginThemeBackgroundArtifact = z.infer<typeof pluginThemeBackgroundSchema>

// Why per-field catch: a style value added later falls back to its default instead of dropping the image.
const tolerantBackgroundSchema = z.object({
  path: backgroundFields.path,
  videoPath: backgroundFields.videoPath.catch(undefined),
  opacity: backgroundStyleFields.opacity.catch(undefined),
  size: backgroundStyleFields.size.catch(undefined),
  position: backgroundStyleFields.position.catch(undefined),
  glass: tolerantGlassSchema
})

/** Runtime keeps a theme whose background is malformed or newer; at worst it paints no image. */
export function tolerantPluginThemeBackground(
  value: unknown
): PluginThemeBackgroundArtifact | undefined {
  const parsed = tolerantBackgroundSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

const installedImageUrlSchema = z
  .string()
  .refine((url) => parsePluginImageUrl(url)?.kind === 'installed')

/** What main hands the renderer: `orca-plugin-image` URLs main serves only after checking the bytes.
 *  `videoUrl` is optional per field so a bad one leaves the static image. */
export const pluginThemeBackgroundRegistrationSchema = z.object({
  url: installedImageUrlSchema,
  videoUrl: installedImageUrlSchema.optional().catch(undefined),
  ...backgroundStyleFields,
  glass: tolerantGlassSchema
})

/** Registration field: an unreadable background drops the image, never the theme. */
export const tolerantPluginThemeBackgroundRegistration = pluginThemeBackgroundRegistrationSchema
  .optional()
  .catch(undefined)

export type PluginThemeBackground = z.infer<typeof pluginThemeBackgroundRegistrationSchema>
