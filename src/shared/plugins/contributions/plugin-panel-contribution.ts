import { z } from 'zod'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import { pluginIdSchema, pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import { PLUGIN_ENUM_SINCE_KEY } from '../manifest/plugin-engine-floor-keys'
import {
  pluginPathFieldDoc,
  pluginFieldDoc,
  PLUGIN_PANEL_PATH_ICON_SINCE,
  PLUGIN_PANEL_UI_SINCE,
  PLUGIN_SCHEMA_SINCE_V1,
  PLUGIN_SOURCE_MODULES_SINCE
} from '../manifest/plugin-schema-field-docs'
import {
  PLUGIN_PANEL_PATH_ICON_DEFAULT_VIEW_BOX,
  PLUGIN_PANEL_PATH_ICON_MAX_LENGTH,
  PLUGIN_PANEL_PATH_ICON_STROKE_VIEW_BOX_MAX,
  pluginPanelPathIconSchema
} from './plugin-panel-path-icon'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const PLUGIN_PANEL_LIMIT = 64

/** Icons a panel (and a component panel's controls) may name; the renderer bundles exactly
 *  these. One vocabulary for manifests and components. Grow additively, with a since below. */
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
  'zap',
  'add',
  'remove',
  'delete',
  'edit',
  'refresh',
  'search',
  'settings',
  'check',
  'close',
  'info',
  'warning',
  'error',
  'open-external',
  'copy',
  'download',
  'upload',
  'play',
  'pause',
  'stop',
  'more',
  'expand',
  'collapse',
  'next',
  'filter',
  'branch',
  'file',
  'agent',
  'link'
] as const

/** Icons added after the first set; older Orcas refuse them, so they raise the engine floor. */
const PLUGIN_PANEL_ICON_SINCE: Record<string, string> = Object.fromEntries(
  PLUGIN_PANEL_ICONS.slice(PLUGIN_PANEL_ICONS.indexOf('add')).map((name) => [
    name,
    PLUGIN_PANEL_UI_SINCE
  ])
)

export type PluginPanelIconName = (typeof PLUGIN_PANEL_ICONS)[number]

const PANEL_ICON_BY_FOLDED_NAME = new Map<string, PluginPanelIconName>(
  PLUGIN_PANEL_ICONS.map((name) => [name.replaceAll('-', ''), name])
)

/** Accepts both Lucide spellings (`file-text`, `FileText`); null for any other name. */
export function canonicalPluginPanelIcon(name: string): PluginPanelIconName | null {
  return PANEL_ICON_BY_FOLDED_NAME.get(name.replaceAll('-', '').toLowerCase()) ?? null
}

/** `html`: the entry is a web page in an isolated frame. `components`: the entry is a module whose
 *  component tree Orca draws with its own controls. */
export const PLUGIN_PANEL_UI_KINDS = ['html', 'components'] as const
export type PluginPanelUi = (typeof PLUGIN_PANEL_UI_KINDS)[number]
const COMPONENTS_PANEL_ENTRY = /\.(?:m?js|tsx?|mts|jsx)$/i

/** A built-in icon name, or (format 2) one inline SVG path drawn in the theme color. */
export const pluginPanelIconSchema = lazyZodSchema(() =>
  z.union([z.enum(PLUGIN_PANEL_ICONS), pluginPanelPathIconSchema])
)

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
        `Icon shown in the right-sidebar activity bar. Defaults to \`puzzle\`. Either a built-in name, or (manifest format 2, needs \`engines.orca\` \`>=${PLUGIN_PANEL_PATH_ICON_SINCE}\`) an object with inline SVG path data that Orca draws in the theme color: \`path\` (required; up to ${PLUGIN_PANEL_PATH_ICON_MAX_LENGTH} characters of SVG path data starting with \`M\`, separated only by spaces, tabs, line breaks and commas), \`viewBox\` (\`"0 0 W H"\`, W and H from 1 to 1024; default \`"${PLUGIN_PANEL_PATH_ICON_DEFAULT_VIEW_BOX}"\`) and \`mode\` (\`stroke\`, the default, draws a 2-unit outline with round caps and joins like Lucide, which assumes a viewBox of about 24, so validation warns when W or H is above ${PLUGIN_PANEL_PATH_ICON_STROKE_VIEW_BOX_MAX}; \`fill\` fills the shape). Unknown keys are refused. SVG files are not supported. In format 2, an object icon that isn't a valid path icon, or a string ending in \`.svg\`, shows \`puzzle\` with a warning; any other value (a misspelled name, \`null\`, an array, a number or a boolean) is a manifest error. Format 1 shows \`puzzle\` with a warning for any icon that isn't a built-in name. Orca draws a single \`<path>\`: for an icon made of several \`<path>\` elements or other shapes (\`<circle>\`, \`<rect>\`, \`<line>\`), convert each shape to path commands and join every \`d\` into one \`path\`. Example: \`{ "path": "M4 4h16v16H4z", "mode": "stroke" }\`.`,

        PLUGIN_SCHEMA_SINCE_V1,
        ['database']
      ),
      [PLUGIN_ENUM_SINCE_KEY]: PLUGIN_PANEL_ICON_SINCE
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
