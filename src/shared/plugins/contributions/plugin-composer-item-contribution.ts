import { z, type RefinementCtx } from 'zod'
import { pluginCommandIdSchema, pluginIdSchema } from '../manifest/plugin-manifest-fields'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import { pluginFieldDoc } from '../manifest/plugin-schema-field-docs'
import {
  PLUGIN_STATUS_BAR_ITEM_LIMIT,
  pluginStatusBarItemDisplayFields,
  pluginStatusBarItemPatchSchema
} from './plugin-status-bar-item-contribution'

export const PLUGIN_COMPOSER_ITEMS_SINCE = '1.4.276'
export const PLUGIN_COMPOSER_ITEM_LIMIT = PLUGIN_STATUS_BAR_ITEM_LIMIT

const popoverContentFields = {
  title: safePluginDisplayText(z.string().min(1).max(100))
    .optional()
    .meta(pluginFieldDoc('Heading of the popover.', PLUGIN_COMPOSER_ITEMS_SINCE, ['Usage'])),
  rows: z
    .array(
      z.strictObject({
        label: safePluginDisplayText(z.string().min(1).max(100)),
        value: safePluginDisplayText(z.string().min(1).max(256))
      })
    )
    .max(12)
    .refine((rows) => new Set(rows.map((row) => row.label)).size === rows.length, {
      error: 'row labels must be unique'
    })
    .optional()
    .meta(
      pluginFieldDoc(
        'Label and value pairs with unique labels. At most 12.',
        PLUGIN_COMPOSER_ITEMS_SINCE
      )
    )
}

const pluginComposerItemPopoverSchema = z
  .strictObject({
    ...popoverContentFields,
    actions: z
      .array(
        z.strictObject({
          label: safePluginDisplayText(z.string().min(1).max(64)),
          command: pluginCommandIdSchema
        })
      )
      .max(4)
      .refine(
        (actions) => new Set(actions.map((action) => action.command)).size === actions.length,
        {
          error: 'action commands must be unique'
        }
      )
      .optional()
      .meta(
        pluginFieldDoc(
          'Buttons that invoke distinct contributed worker commands. At most 4.',
          PLUGIN_COMPOSER_ITEMS_SINCE
        )
      )
  })
  .meta({
    id: 'ComposerItemPopover',
    description:
      'Details and actions shown when the user presses a composer item. Use at most one of `popover` and `command`; a text-only item needs neither.'
  })

export type PluginComposerItemPopover = z.infer<typeof pluginComposerItemPopoverSchema>

export const pluginComposerItemResultSchema = pluginStatusBarItemPatchSchema
  .extend({ popover: z.strictObject(popoverContentFields).nullable().optional() })
  .nullable()

export const pluginComposerItemContributionSchema = z
  .strictObject({
    id: pluginIdSchema.meta(
      pluginFieldDoc(
        "Item id, unique among this plugin's composer items.",
        PLUGIN_COMPOSER_ITEMS_SINCE
      )
    ),
    text: pluginStatusBarItemDisplayFields.text.meta(
      pluginFieldDoc('Short label shown in the chat.', PLUGIN_COMPOSER_ITEMS_SINCE)
    ),
    icon: pluginStatusBarItemDisplayFields.icon.meta(
      pluginFieldDoc('Icon from the panel icon set.', PLUGIN_COMPOSER_ITEMS_SINCE)
    ),
    tone: pluginStatusBarItemDisplayFields.tone.meta(
      pluginFieldDoc('Colour of the item. Defaults to neutral.', PLUGIN_COMPOSER_ITEMS_SINCE)
    ),
    tooltip: pluginStatusBarItemDisplayFields.tooltip.meta(
      pluginFieldDoc('Shown on hover. Defaults to the plugin name.', PLUGIN_COMPOSER_ITEMS_SINCE)
    ),
    placement: z
      .enum(['toolbar', 'footer'])
      .optional()
      .meta(
        pluginFieldDoc(
          'Toolbar beside the model controls, or footer beside the workspace and branch. Defaults to toolbar.',
          PLUGIN_COMPOSER_ITEMS_SINCE,
          ['footer']
        )
      ),
    resolve: pluginCommandIdSchema
      .optional()
      .meta(
        pluginFieldDoc(
          'Worker command that receives the chat context and returns the display fields, or null to hide the item. Orca calls it when a chat opens, when its agent settles after a turn, and when its model changes.',
          PLUGIN_COMPOSER_ITEMS_SINCE
        )
      ),
    popover: pluginComposerItemPopoverSchema
      .optional()
      .meta(
        pluginFieldDoc(
          'Opens a native popover when pressed. A resolver can update its content. Mutually exclusive with the item command.',
          PLUGIN_COMPOSER_ITEMS_SINCE
        )
      ),
    command: pluginCommandIdSchema
      .optional()
      .meta(
        pluginFieldDoc(
          'Worker command run when the item is pressed. Receives the same chat context as the resolver.',
          PLUGIN_COMPOSER_ITEMS_SINCE
        )
      )
  })
  .meta({
    id: 'ComposerItemContribution',
    description: 'An item in the native Chat composer on desktop.'
  })

export type PluginComposerItemContribution = z.infer<typeof pluginComposerItemContributionSchema>

export function validatePluginComposerItems(
  contributes: {
    commands: readonly { id: string; action?: string; replaces?: string }[]
    composerItems: readonly PluginComposerItemContribution[]
  },
  ctx: RefinementCtx
): void {
  const ids = new Set<string>()
  const commands = new Map(contributes.commands.map((command) => [command.id, command]))
  for (const [index, item] of contributes.composerItems.entries()) {
    if (ids.has(item.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'composerItems', index, 'id'],
        message: `duplicate composerItems id: ${item.id}`
      })
    }
    ids.add(item.id)
    if (item.command && item.popover) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'composerItems', index, 'popover'],
        message: 'use either command or popover for the item click'
      })
    }
    const validateCommand = (id: string, path: (string | number)[]): void => {
      const command = commands.get(id)
      if (!command || command.action !== undefined || command.replaces !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['contributes', 'composerItems', index, ...path],
          message: `expected an ordinary contributed worker command: ${id}`
        })
      }
    }
    if (item.resolve) {
      validateCommand(item.resolve, ['resolve'])
    }
    if (item.command) {
      validateCommand(item.command, ['command'])
    }
    for (const [actionIndex, action] of (item.popover?.actions ?? []).entries()) {
      validateCommand(action.command, ['popover', 'actions', actionIndex, 'command'])
    }
  }
}
