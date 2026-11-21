import { z } from 'zod'
import { PLUGIN_PANEL_PATH_ICON_SINCE } from '../manifest/plugin-schema-field-docs'

export const PLUGIN_PANEL_PATH_ICON_MODES = ['stroke', 'fill'] as const
export type PluginPanelPathIconMode = (typeof PLUGIN_PANEL_PATH_ICON_MODES)[number]

export const PLUGIN_PANEL_PATH_ICON_MAX_LENGTH = 4096
export const PLUGIN_PANEL_PATH_ICON_DEFAULT_VIEW_BOX = '0 0 24 24'

// Why a closed grammar: only path commands, numbers and separators, so `d` can never carry markup.
const PATH_DATA = /^[Mm][MmLlHhVvCcSsQqTtAaZz0-9\s,.+\-eE]*$/
const VIEW_BOX = /^0 0 ([1-9]\d{0,3}) ([1-9]\d{0,3})$/

function isPanelIconViewBox(value: string): boolean {
  const match = VIEW_BOX.exec(value)
  return !!match && Number(match[1]) <= 1024 && Number(match[2]) <= 1024
}

export const pluginPanelPathIconSchema = z
  .strictObject({
    path: z
      .string({ error: 'must be a string' })
      .min(1, 'must not be empty')
      .max(
        PLUGIN_PANEL_PATH_ICON_MAX_LENGTH,
        `must be at most ${PLUGIN_PANEL_PATH_ICON_MAX_LENGTH} characters`
      )
      .regex(PATH_DATA, 'must be SVG path data that starts with M and uses only path commands')
      .meta({ description: 'SVG path data (the `d` attribute of one `<path>`).' }),
    viewBox: z
      .string({ error: 'must be a string' })
      .refine(isPanelIconViewBox, 'must be "0 0 W H" with W and H from 1 to 1024')
      .optional()
      .meta({
        description: `Coordinate box of \`path\`. Defaults to \`${PLUGIN_PANEL_PATH_ICON_DEFAULT_VIEW_BOX}\`.`
      }),
    mode: z.enum(PLUGIN_PANEL_PATH_ICON_MODES).optional().meta({
      description:
        '`stroke` (default) draws the outline 2 units wide with round caps and joins, like Lucide; `fill` fills the shape.'
    })
  })
  .meta({ 'x-orca-since': PLUGIN_PANEL_PATH_ICON_SINCE })

export type PluginPanelPathIcon = z.infer<typeof pluginPanelPathIconSchema>

/** A path icon with its defaults applied, as main sends it to clients. */
export type ResolvedPluginPanelPathIcon = {
  path: string
  viewBox: string
  mode: PluginPanelPathIconMode
}

/** The icon with defaults applied, or null when it is not a valid path icon. */
export function resolvePluginPanelPathIcon(value: unknown): ResolvedPluginPanelPathIcon | null {
  const parsed = pluginPanelPathIconSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }
  return {
    path: parsed.data.path,
    viewBox: parsed.data.viewBox ?? PLUGIN_PANEL_PATH_ICON_DEFAULT_VIEW_BOX,
    mode: parsed.data.mode ?? 'stroke'
  }
}

/** Why an icon is unusable, or null when it is a valid path icon. */
export function pluginPanelPathIconIssue(value: unknown): string | null {
  const parsed = pluginPanelPathIconSchema.safeParse(value)
  if (parsed.success) {
    return null
  }
  const [issue] = parsed.error.issues
  if (!issue) {
    return 'invalid icon'
  }
  if (issue.code === 'unrecognized_keys') {
    return `unknown key ${issue.keys.map((key) => `"${key}"`).join(', ')}`
  }
  const field = issue.path.join('.')
  return field ? `icon.${field} ${issue.message}` : issue.message
}
