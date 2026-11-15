import { z } from 'zod'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import { pluginIdSchema, pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import { PLUGIN_ENUM_SINCE_KEY } from '../manifest/plugin-engine-floor-keys'
import {
  pluginPathFieldDoc,
  pluginFieldDoc,
  PLUGIN_PANEL_ICON_SINCE,
  PLUGIN_PANEL_UI_SINCE,
  PLUGIN_SCHEMA_SINCE_V1,
  PLUGIN_SOURCE_MODULES_SINCE
} from '../manifest/plugin-schema-field-docs'
import { PLUGIN_PANEL_ICONS, pluginPanelIconSchema } from './plugin-panel-icon'

export const PLUGIN_PANEL_LIMIT = 64

export {
  PLUGIN_PANEL_ICONS,
  canonicalPluginPanelIcon,
  type PluginPanelIconName
} from './plugin-panel-icon'

/** Icons added after the first set; older Orcas refuse them, so they raise the engine floor. */
const PLUGIN_PANEL_NAME_SINCE: Record<string, string> = Object.fromEntries(
  PLUGIN_PANEL_ICONS.slice(PLUGIN_PANEL_ICONS.indexOf('add')).map((name) => [
    name,
    PLUGIN_PANEL_UI_SINCE
  ])
)

/** `html`: the entry is a web page in an isolated frame. `components`: the entry is a module whose
 *  component tree Orca draws with its own controls. */
export const PLUGIN_PANEL_UI_KINDS = ['html', 'components'] as const
export type PluginPanelUi = (typeof PLUGIN_PANEL_UI_KINDS)[number]
const COMPONENTS_PANEL_ENTRY = /\.(?:m?js|tsx?|mts|jsx)$/i

export const pluginPanelContributionSchema = z
  .object({
    id: pluginIdSchema.meta(
      pluginFieldDoc(
        "Panel id, unique among this plugin's panels. The reserved names `constructor` and `prototype` are refused.",
        PLUGIN_SCHEMA_SINCE_V1,
        ['dashboard']
      )
    ),
    title: safePluginDisplayText(z.string().min(1).max(256)).meta(
      pluginFieldDoc('Title shown on the panel tab and its tooltip.', PLUGIN_SCHEMA_SINCE_V1, [
        'Dashboard'
      ])
    ),
    icon: pluginPanelIconSchema.optional().meta({
      ...pluginFieldDoc(
        `Icon shown in the right-sidebar activity bar: a built-in name, one emoji, or a plugin-relative \`.svg\` or \`.png\` file (at most 32 KB; SVG must be static, monochrome-ready and have a \`viewBox\`). Defaults to \`plug\`. File and emoji icons need Orca >=${PLUGIN_PANEL_ICON_SINCE}.`,
        PLUGIN_SCHEMA_SINCE_V1,
        ['database', '🧩', 'icons/panel.svg']
      ),
      [PLUGIN_ENUM_SINCE_KEY]: PLUGIN_PANEL_NAME_SINCE
    }),
    entry: pluginRelativePathSchema.meta(
      pluginPathFieldDoc(
        `What the panel runs: an HTML page for \`ui: "html"\`, a \`.js\`/\`.mjs\` module for \`ui: "components"\`. Either may instead be a \`.ts\`/\`.tsx\`/\`.mts\`/\`.jsx\` file, which Orca transpiles when it loads (needs \`engines.orca\` \`>=${PLUGIN_SOURCE_MODULES_SINCE}\`; an \`html\` panel then gets a generated page around it). It is trusted code: install panels you trust.`,
        PLUGIN_SCHEMA_SINCE_V1,
        ['dist/panel.html']
      )
    ),
    ui: z
      .enum(PLUGIN_PANEL_UI_KINDS)
      .optional()
      .meta(
        pluginFieldDoc(
          'How the panel draws its UI. `html` (default) shows `entry` as a web page in an isolated frame; `components` runs `entry` as a hidden module and Orca draws the component tree it returns with its own controls.',
          PLUGIN_PANEL_UI_SINCE,
          ['components']
        )
      )
  })
  .strict()
  .refine((panel) => panel.ui !== 'components' || COMPONENTS_PANEL_ENTRY.test(panel.entry), {
    path: ['entry'],
    message: 'a components panel entry must be a .js, .mjs, .ts, .tsx, .mts or .jsx module'
  })
  .meta({
    id: 'PanelContribution',
    description: 'A sidebar panel. Requires the `sandboxed-ui` execution profile or higher.'
  })

export type PluginPanelContribution = z.infer<typeof pluginPanelContributionSchema>
