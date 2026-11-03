import { z } from 'zod'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import { pluginIdSchema, pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import { pluginFieldDoc, pluginPathFieldDoc } from '../manifest/plugin-schema-field-docs'
import { PLUGIN_SIDEBAR_CARDS_SINCE } from './plugin-sidebar-card-contribution'

export const PLUGIN_WORKSPACE_LIST_LIMIT = 8

const SINCE = PLUGIN_SIDEBAR_CARDS_SINCE

export const pluginWorkspaceListContributionSchema = z
  .object({
    id: pluginIdSchema.meta(
      pluginFieldDoc("Arrangement id, unique among this plugin's lists.", SINCE, ['review-flow'])
    ),
    title: safePluginDisplayText(z.string().min(1).max(128)).meta(
      pluginFieldDoc('Name shown where people pick how the list is arranged.', SINCE, [
        'Review flow'
      ])
    ),
    description: safePluginDisplayText(z.string().max(512))
      .optional()
      .meta(pluginFieldDoc('One line on how it arranges workspaces.', SINCE)),
    arrangement: pluginRelativePathSchema.meta(
      pluginPathFieldDoc(
        'JSON list arrangement (sections, rules and sort), at most 32 KiB.',
        SINCE,
        ['lists/review-flow.json']
      )
    )
  })
  .strict()
  .meta({
    id: 'WorkspaceListContribution',
    description:
      "An arrangement of the left sidebar's workspace list into sections, drawn by Orca from rules; it runs no code."
  })

export type PluginWorkspaceListContribution = z.infer<typeof pluginWorkspaceListContributionSchema>
