import { z } from 'zod'
import { PLUGIN_PANEL_PATH_ICON_SINCE } from '../manifest/plugin-schema-field-docs'
import { svgPathDataIssue } from './plugin-panel-path-data'

export const PLUGIN_PANEL_PATH_ICON_MODES = ['stroke', 'fill'] as const
export type PluginPanelPathIconMode = (typeof PLUGIN_PANEL_PATH_ICON_MODES)[number]

export const PLUGIN_PANEL_PATH_ICON_MAX_LENGTH = 4096
export const PLUGIN_PANEL_PATH_ICON_DEFAULT_VIEW_BOX = '0 0 24 24'

// Why both: the pattern publishes the character set to editors; svgPathDataIssue checks the
// grammar (arity, arc flags, separators), so `d` can never carry markup or draw half a path.
const PATH_CHARACTERS = /^[Mm][MmLlHhVvCcSsQqTtAaZz0-9 \t\r\n\f,.+\-eE]*$/
// Why a pattern, not a refine: the published JSON Schema then carries the 1 to 1024 bounds.
const VIEW_BOX_SIDE = '(?:[1-9]\\d{0,2}|10[01]\\d|102[0-4])'
const VIEW_BOX = new RegExp(`^0 0 ${VIEW_BOX_SIDE} ${VIEW_BOX_SIDE}$`)
/** Above this, Lucide's 2-unit stroke is too thin to read at activity-bar size. */
export const PLUGIN_PANEL_PATH_ICON_STROKE_VIEW_BOX_MAX = 48

export const pluginPanelPathIconSchema = z
  .strictObject({
    path: z
      .string({ error: 'must be a string' })
      .min(1, 'must not be empty')
      // Why abort: zod runs later checks after a failed one, so an oversized path would still
      // get the full pattern and grammar scan; stop at the cap instead.
      .max(PLUGIN_PANEL_PATH_ICON_MAX_LENGTH, {
        error: `must be at most ${PLUGIN_PANEL_PATH_ICON_MAX_LENGTH} characters`,
        abort: true
      })
      .regex(
        PATH_CHARACTERS,
        'must be SVG path data that starts with M and uses only path commands, numbers, commas and spaces'
      )
      .superRefine((data, ctx) => {
        const issue = svgPathDataIssue(data)
        if (issue) {
          ctx.addIssue({ code: 'custom', message: issue })
        }
      })
      .meta({ description: 'SVG path data (the `d` attribute of one `<path>`).' }),
    viewBox: z
      .string({ error: 'must be a string' })
      .regex(VIEW_BOX, 'must be "0 0 W H" with W and H from 1 to 1024')
      .optional()
      .meta({
        description: `Coordinate box of \`path\`. Defaults to \`${PLUGIN_PANEL_PATH_ICON_DEFAULT_VIEW_BOX}\`.`
      }),
    mode: z
      .enum(PLUGIN_PANEL_PATH_ICON_MODES)
      .optional()
      .meta({
        description: `\`stroke\` (default) draws the outline 2 units wide with round caps and joins, like Lucide, which suits a viewBox of about 24; validation warns above ${PLUGIN_PANEL_PATH_ICON_STROKE_VIEW_BOX_MAX}. \`fill\` fills the shape.`
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
