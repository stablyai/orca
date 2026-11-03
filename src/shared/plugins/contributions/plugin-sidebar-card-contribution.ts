import { z } from 'zod'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import { pluginIdSchema, pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import { pluginFieldDoc, pluginPathFieldDoc } from '../manifest/plugin-schema-field-docs'

/** First release that reads `contributes.sidebarCards`. */
export const PLUGIN_SIDEBAR_CARDS_SINCE = '1.4.249'
export const PLUGIN_SIDEBAR_CARD_LIMIT = 16

const SINCE = PLUGIN_SIDEBAR_CARDS_SINCE

export const pluginSidebarCardContributionSchema = z
  .object({
    id: pluginIdSchema.meta(
      pluginFieldDoc("Card id, unique among this plugin's cards.", SINCE, ['review-first'])
    ),
    title: safePluginDisplayText(z.string().min(1).max(128)).meta(
      pluginFieldDoc('Name shown where people pick a card.', SINCE, ['Review first'])
    ),
    description: safePluginDisplayText(z.string().max(512))
      .optional()
      .meta(pluginFieldDoc('One line on what the card emphasizes.', SINCE)),
    template: pluginRelativePathSchema.meta(
      pluginPathFieldDoc(
        'JSON card template, at most 64 KiB. See the workspace card reference.',
        SINCE,
        ['cards/review-first.json']
      )
    )
  })
  .strict()
  .meta({
    id: 'SidebarCardContribution',
    description:
      'A workspace card for the left sidebar, drawn by Orca from a template; it runs no code.'
  })

export type PluginSidebarCardContribution = z.infer<typeof pluginSidebarCardContributionSchema>
