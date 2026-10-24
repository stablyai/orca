import { z } from 'zod'
import { pluginIdSchema, pluginRelativePathSchema } from './manifest/plugin-manifest-fields'
import {
  pluginPathFieldDoc,
  pluginFieldDoc,
  PLUGIN_SCHEMA_SINCE_V1
} from './manifest/plugin-schema-field-docs'

export const PLUGIN_PANEL_LIMIT = 64

export const pluginPanelContributionSchema = z
  .object({
    id: pluginIdSchema.meta(
      pluginFieldDoc(
        "Panel id, unique among this plugin's panels. The reserved names `constructor` and `prototype` are refused.",
        PLUGIN_SCHEMA_SINCE_V1,
        ['dashboard']
      )
    ),
    title: z
      .string()
      .min(1)
      .max(256)
      .meta(
        pluginFieldDoc('Title shown on the panel tab and its tooltip.', PLUGIN_SCHEMA_SINCE_V1, [
          'Dashboard'
        ])
      ),
    icon: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .meta(
        pluginFieldDoc(
          'Lucide icon name shown in the right-sidebar activity bar.',
          PLUGIN_SCHEMA_SINCE_V1,
          ['layout-dashboard']
        )
      ),
    entry: pluginRelativePathSchema.meta(
      pluginPathFieldDoc(
        'HTML file, relative to the plugin root, rendered inside a sandboxed panel frame.',
        PLUGIN_SCHEMA_SINCE_V1,
        ['dist/panel.html']
      )
    )
  })
  .strict()
  .meta({
    id: 'PanelContribution',
    description: 'A sidebar panel. Requires the `sandboxed-ui` execution profile or higher.'
  })

export type PluginPanelContribution = z.infer<typeof pluginPanelContributionSchema>
