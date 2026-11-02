import { z } from 'zod'
import { pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import {
  PLUGIN_MANIFEST_V2_SINCE,
  pluginFieldDoc,
  pluginPathFieldDoc
} from '../manifest/plugin-schema-field-docs'
import { PLUGIN_THEME_BACKGROUND_RULE_TEXT } from '../images/plugin-image-fields'
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

const backgroundFields = {
  path: pluginRelativePathSchema.meta(
    pluginPathFieldDoc(`Image file in the plugin. ${PLUGIN_THEME_BACKGROUND_RULE_TEXT}`, NEXT, [
      'images/dusk.webp'
    ])
  ),
  ...backgroundStyleFields
}

/** `validate:plugin` shape: unknown keys fail authoring. */
export const pluginThemeBackgroundSchema = z
  .strictObject(backgroundFields)
  .meta(
    pluginFieldDoc(
      'One image painted under translucent terminals and chats (Background Opacity below 1). Static; never blurred.',
      NEXT
    )
  )

export type PluginThemeBackgroundArtifact = z.infer<typeof pluginThemeBackgroundSchema>

// Why per-field catch: a style value added later falls back to its default instead of dropping the image.
const tolerantBackgroundSchema = z.object({
  path: backgroundFields.path,
  opacity: backgroundStyleFields.opacity.catch(undefined),
  size: backgroundStyleFields.size.catch(undefined),
  position: backgroundStyleFields.position.catch(undefined)
})

/** Runtime keeps a theme whose background is malformed or newer; at worst it paints no image. */
export function tolerantPluginThemeBackground(
  value: unknown
): PluginThemeBackgroundArtifact | undefined {
  const parsed = tolerantBackgroundSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** What main hands the renderer: an `orca-plugin-image` URL main serves only after checking the bytes. */
export const pluginThemeBackgroundRegistrationSchema = z.object({
  url: z.string().refine((url) => parsePluginImageUrl(url)?.kind === 'installed'),
  ...backgroundStyleFields
})

/** Registration field: an unreadable background drops the image, never the theme. */
export const tolerantPluginThemeBackgroundRegistration = pluginThemeBackgroundRegistrationSchema
  .optional()
  .catch(undefined)

export type PluginThemeBackground = z.infer<typeof pluginThemeBackgroundRegistrationSchema>
