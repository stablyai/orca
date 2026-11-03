import { z } from 'zod'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import { pluginFieldDoc } from '../manifest/plugin-schema-field-docs'
import { cardTemplateSchema } from '../../workspace-cards/card-template-schema'
import { PLUGIN_SIDEBAR_CARDS_SINCE } from '../contributions/plugin-sidebar-card-contribution'

/** A release's workspace cards, drawn in the Card Studio before install. */
export const pluginCatalogCardPreviewField = z
  .array(
    z
      .strictObject({
        label: safePluginDisplayText(z.string().min(1).max(128)).meta(
          pluginFieldDoc('Card name.', PLUGIN_SIDEBAR_CARDS_SINCE, ['Review first'])
        ),
        template: cardTemplateSchema.meta(
          pluginFieldDoc(
            "The card's template, the same file the plugin ships, so Orca can preview it before install.",
            PLUGIN_SIDEBAR_CARDS_SINCE
          )
        )
      })
      .meta({
        id: 'CatalogCardPreview',
        description: 'A workspace card to draw before install.'
      })
  )
  .max(4)
  .optional()
  .catch(undefined)
  .meta(
    pluginFieldDoc(
      'Up to 4 workspace cards to preview before install. Orca draws them from made-up workspaces; the installed files decide the real cards.',
      PLUGIN_SIDEBAR_CARDS_SINCE
    )
  )
