import { z } from 'zod'
import { pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import { PLUGIN_PANEL_ICON_FILE_EXTENSION } from './plugin-panel-icon-file'

export {
  PLUGIN_PANEL_ICON_FILE_MAX_BYTES,
  pluginPanelIconFileError
} from './plugin-panel-icon-file'
export {
  PLUGIN_ICON_SVG_ATTRIBUTES,
  PLUGIN_ICON_SVG_ELEMENTS,
  isSafePluginIconAttributeValue,
  pluginPanelIconSvgError
} from './plugin-panel-icon-svg'

/** Icons a panel may name without shipping a file. */
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

export type PluginPanelIconName = (typeof PLUGIN_PANEL_ICONS)[number]
export type PluginPanelIconKind = 'builtin' | 'file'

const PANEL_ICON_BY_FOLDED_NAME = new Map<string, PluginPanelIconName>(
  PLUGIN_PANEL_ICONS.map((name) => [name.replaceAll('-', ''), name])
)

/** Accepts both Lucide spellings (`file-text`, `FileText`); null for any other name. */
export function canonicalPluginPanelIcon(name: string): PluginPanelIconName | null {
  return PANEL_ICON_BY_FOLDED_NAME.get(name.replaceAll('-', '').toLowerCase()) ?? null
}

const fileIconSchema = pluginRelativePathSchema.regex(
  PLUGIN_PANEL_ICON_FILE_EXTENSION,
  'must be an .svg file'
)

export function pluginPanelIconKind(value: string): PluginPanelIconKind | null {
  if (canonicalPluginPanelIcon(value)) {
    return 'builtin'
  }
  if (fileIconSchema.safeParse(value).success) {
    return 'file'
  }
  return null
}

export const pluginPanelIconSchema = z.union([z.enum(PLUGIN_PANEL_ICONS), fileIconSchema])
