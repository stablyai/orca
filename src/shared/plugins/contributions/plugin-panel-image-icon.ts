import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import { PLUGIN_PANEL_IMAGE_ICON_SINCE } from '../manifest/plugin-schema-field-docs'
import { isPluginJsonObject } from '../manifest/plugin-json-object'
import { PLUGIN_ICON_RULE_TEXT } from '../images/plugin-image-fields'
import { pluginPanelObjectIconIssue } from './plugin-panel-path-icon'

export const pluginPanelImageIconSchema = lazyZodSchema(() =>
  z
    .strictObject({
      image: pluginRelativePathSchema.meta({
        description: `Image file drawn in its own colors on the panel's button. ${PLUGIN_ICON_RULE_TEXT}`
      })
    })
    .meta({ 'x-orca-since': PLUGIN_PANEL_IMAGE_ICON_SINCE })
)

/** An icon meant as an image, valid or not: an object with its own `image` key. */
export function isPluginPanelImageIcon(icon: unknown): boolean {
  return isPluginJsonObject(icon) && !Array.isArray(icon) && Object.hasOwn(icon, 'image')
}

/** The file of a valid image icon, else undefined. */
export function pluginPanelImageIconPath(icon: unknown): string | undefined {
  const parsed = pluginPanelImageIconSchema.safeParse(icon)
  return parsed.success ? parsed.data.image : undefined
}

/** Why an icon is unusable, or null when it is a valid image icon. */
export function pluginPanelImageIconIssue(value: unknown): string | null {
  return pluginPanelObjectIconIssue(pluginPanelImageIconSchema, value)
}

/** The image slot a panel's icon is served under. */
export function pluginPanelIconSlot(panelIndex: number): string {
  return `panel-${panelIndex}`
}
