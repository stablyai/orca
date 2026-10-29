import { z } from 'zod'
import { pluginIdSchema, pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import {
  pluginPathFieldDoc,
  pluginFieldDoc,
  PLUGIN_SCHEMA_SINCE_V1
} from '../manifest/plugin-schema-field-docs'

export const PLUGIN_PANEL_LIMIT = 64

/** Icons a panel may name; the renderer bundles exactly these. Grow additively. */
export const PLUGIN_PANEL_ICONS = [
  'activity',
  'bar-chart-3',
  'bell',
  'blocks',
  'book',
  'bot',
  'bug',
  'calendar',
  'cloud',
  'code',
  'database',
  'file-text',
  'flag',
  'folder',
  'gauge',
  'globe',
  'hammer',
  'layers',
  'lightbulb',
  'package',
  'plug',
  'puzzle',
  'rocket',
  'star',
  'terminal',
  'wrench',
  'zap'
] as const

export type PluginPanelIconName = (typeof PLUGIN_PANEL_ICONS)[number]

const PANEL_ICON_BY_FOLDED_NAME = new Map<string, PluginPanelIconName>(
  PLUGIN_PANEL_ICONS.map((name) => [name.replaceAll('-', ''), name])
)

/** Accepts both Lucide spellings (`file-text`, `FileText`); null for any other name. */
export function canonicalPluginPanelIcon(name: string): PluginPanelIconName | null {
  return PANEL_ICON_BY_FOLDED_NAME.get(name.replaceAll('-', '').toLowerCase()) ?? null
}

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
      .enum(PLUGIN_PANEL_ICONS)
      .optional()
      .meta(
        pluginFieldDoc(
          'Icon shown in the right-sidebar activity bar. Defaults to `plug`.',
          PLUGIN_SCHEMA_SINCE_V1,
          ['database']
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
