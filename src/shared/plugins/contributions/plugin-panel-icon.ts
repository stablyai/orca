import { z } from 'zod'
import { pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import { pluginPanelIconFileFormat } from './plugin-panel-icon-format'

export {
  PLUGIN_PANEL_ICON_FILE_MAX_BYTES,
  pluginPanelIconFileFormat,
  type PluginPanelIconFileFormat
} from './plugin-panel-icon-format'
export { pluginPanelIconFileError } from './plugin-panel-icon-file'
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
export type PluginPanelIconKind = 'builtin' | 'emoji' | 'file'

const PANEL_ICON_BY_FOLDED_NAME = new Map<string, PluginPanelIconName>(
  PLUGIN_PANEL_ICONS.map((name) => [name.replaceAll('-', ''), name])
)
const EMOJI_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' })
const EMOJI_CHARACTER = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u
const KEYCAP = /^[0-9#*]\uFE0F\u20E3$/u

/** Accepts both Lucide spellings (`file-text`, `FileText`); null for any other name. */
export function canonicalPluginPanelIcon(name: string): PluginPanelIconName | null {
  return PANEL_ICON_BY_FOLDED_NAME.get(name.replaceAll('-', '').toLowerCase()) ?? null
}

export function isPluginPanelIconEmoji(value: string): boolean {
  if (value.length === 0 || value.length > 32) {
    return false
  }
  const segments = [...EMOJI_SEGMENTER.segment(value)]
  const grapheme = segments.length === 1 ? segments[0]?.segment : undefined
  return (
    grapheme !== undefined &&
    (KEYCAP.test(grapheme) ||
      EMOJI_PRESENTATION.test(grapheme) ||
      /^\p{Regional_Indicator}$/u.test(grapheme) ||
      (grapheme.includes('\uFE0F') && EMOJI_CHARACTER.test(grapheme)))
  )
}

export function pluginPanelIconKind(value: string): PluginPanelIconKind | null {
  if (canonicalPluginPanelIcon(value)) {
    return 'builtin'
  }
  if (pluginPanelIconFileFormat(value) && pluginRelativePathSchema.safeParse(value).success) {
    return 'file'
  }
  return isPluginPanelIconEmoji(value) ? 'emoji' : null
}

const PLUGIN_PANEL_ICON_FORMS =
  'must be a built-in icon name, one emoji, or a plugin-relative .svg or .png path'

const emojiIconSchema = z
  .string()
  .min(1)
  .max(32)
  .refine(isPluginPanelIconEmoji, PLUGIN_PANEL_ICON_FORMS)

const fileIconSchema = pluginRelativePathSchema.refine(
  (value) => pluginPanelIconFileFormat(value) !== null,
  PLUGIN_PANEL_ICON_FORMS
)

export const pluginPanelIconSchema = z.union([
  z.enum(PLUGIN_PANEL_ICONS),
  emojiIconSchema,
  fileIconSchema
])
