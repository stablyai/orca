import { z } from 'zod'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import { pluginIdSchema, pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import { pluginFieldDoc, pluginPathFieldDoc } from '../manifest/plugin-schema-field-docs'
import { pluginSettingContributionSchema } from './plugin-settings-contribution'

/** First release that reads `contributes.sidebarCards`. */
export const PLUGIN_SIDEBAR_CARDS_SINCE = '1.4.248'
export const PLUGIN_SIDEBAR_CARD_LIMIT = 16
export const PLUGIN_SIDEBAR_CARD_OPTION_LIMIT = 24

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
    ),
    options: z
      .array(pluginSettingContributionSchema)
      .max(PLUGIN_SIDEBAR_CARD_OPTION_LIMIT)
      .optional()
      .meta(
        pluginFieldDoc(
          `Options people set for this card in the Card Studio, in the settings format; the template reads them as \`cardOptions.<key>\`. At most ${PLUGIN_SIDEBAR_CARD_OPTION_LIMIT}.`,
          SINCE
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
