import { z, type RefinementCtx } from 'zod'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import { pluginCommandIdSchema, pluginIdSchema } from '../manifest/plugin-manifest-fields'
import {
  pluginFieldDoc,
  PLUGIN_COMPONENTS_CATALOG_2_SINCE
} from '../manifest/plugin-schema-field-docs'
import { PLUGIN_DECLARATIVE_TONES } from '../declarative/plugin-declarative-prop-schemas'
import { PLUGIN_PANEL_ICONS } from './plugin-panel-contribution'

/** First release that reads `contributes.statusBarItems` and `statusBar.update`. */
export const PLUGIN_STATUS_BAR_SINCE = PLUGIN_COMPONENTS_CATALOG_2_SINCE
export const PLUGIN_STATUS_BAR_ITEM_LIMIT = 8
export const PLUGIN_STATUS_BAR_TEXT_MAX_LENGTH = 64
export const PLUGIN_STATUS_BAR_TOOLTIP_MAX_LENGTH = 256

const SINCE = PLUGIN_STATUS_BAR_SINCE

/** The fields a worker may change at runtime; the manifest declares their first values. */
export const pluginStatusBarItemDisplayFields = {
  text: safePluginDisplayText(z.string().max(PLUGIN_STATUS_BAR_TEXT_MAX_LENGTH))
    .optional()
    .meta(pluginFieldDoc('Short label shown in the status bar.', SINCE, ['3 blocked'])),
  icon: z
    .enum(PLUGIN_PANEL_ICONS)
    .optional()
    .meta(pluginFieldDoc('Icon shown before the text, from the panel icon set.', SINCE, ['bell'])),
  tone: z
    .enum(PLUGIN_DECLARATIVE_TONES)
    .optional()
    .meta(pluginFieldDoc('Colour of the item. Defaults to `neutral`.', SINCE, ['warning'])),
  tooltip: safePluginDisplayText(z.string().max(PLUGIN_STATUS_BAR_TOOLTIP_MAX_LENGTH))
    .optional()
    .meta(pluginFieldDoc('Shown on hover. Defaults to the plugin name.', SINCE))
}

export const pluginStatusBarItemContributionSchema = z
  .object({
    id: pluginIdSchema.meta(
      pluginFieldDoc(
        "Item id, unique among this plugin's status bar items; `statusBar.update` names it.",
        SINCE,
        ['blocked-count']
      )
    ),
    ...pluginStatusBarItemDisplayFields,
    command: pluginCommandIdSchema
      .optional()
      .meta(
        pluginFieldDoc(
          'Id of a command this plugin contributes in `contributes.commands`, run when the item is pressed.',
          SINCE,
          ['guard.showLog']
        )
      )
  })
  .strict()
  .meta({
    id: 'StatusBarItemContribution',
    description:
      'An item in the status bar. Requires the `declarative` profile; a `trusted-worker` can change it with `statusBar.update`.'
  })

export type PluginStatusBarItemContribution = z.infer<typeof pluginStatusBarItemContributionSchema>

/** What `statusBar.update` sets; an absent field keeps its value, `visible: false` hides it. */
export const pluginStatusBarItemPatchSchema = z.strictObject({
  ...pluginStatusBarItemDisplayFields,
  visible: z.boolean().optional()
})
export type PluginStatusBarItemPatch = z.infer<typeof pluginStatusBarItemPatchSchema>

export function validatePluginStatusBarItems(
  contributes: {
    commands: readonly { id: string }[]
    statusBarItems: readonly { id: string; command?: string }[]
  },
  ctx: RefinementCtx
): void {
  const ids = new Set<string>()
  const commands = new Set(contributes.commands.map((command) => command.id))
  for (const [index, item] of contributes.statusBarItems.entries()) {
    if (ids.has(item.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'statusBarItems', index],
        message: `duplicate statusBarItems id: ${item.id}`
      })
    }
    ids.add(item.id)
    if (item.command !== undefined && !commands.has(item.command)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'statusBarItems', index, 'command'],
        message: `unknown contributed command: ${item.command}`
      })
    }
  }
}
