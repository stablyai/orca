import { z } from 'zod'
import { pluginCommandIdSchema, pluginIdSchema } from './plugin-manifest-fields'

/**
 * Plugin status-bar items: declared in `contributes.statusBarItems`, filled
 * with text by the worker through `statusBar.update`. Electron-free so the
 * manifest schema, the host API table, main, and the renderer share one
 * contract.
 */

export const PLUGIN_STATUS_BAR_ITEM_LIMIT = 8
export const PLUGIN_STATUS_BAR_TEXT_MAX_LENGTH = 80
export const PLUGIN_STATUS_BAR_TOOLTIP_MAX_LENGTH = 512
export const PLUGIN_STATUS_BAR_PRIORITY_LIMIT = 10_000
/** Each item reaches the renderer at most this often (4 updates/s); updates
 *  in between coalesce to the latest state. */
export const PLUGIN_STATUS_BAR_UPDATE_INTERVAL_MS = 250

export const PLUGIN_STATUS_BAR_SEVERITIES = ['normal', 'warning', 'error'] as const
export type PluginStatusBarSeverity = (typeof PLUGIN_STATUS_BAR_SEVERITIES)[number]

export const pluginStatusBarItemContributionSchema = z
  .object({
    id: pluginIdSchema,
    alignment: z.enum(['left', 'right']).optional(),
    /** Higher priority renders first within its alignment group. */
    priority: z
      .number()
      .int()
      .min(-PLUGIN_STATUS_BAR_PRIORITY_LIMIT)
      .max(PLUGIN_STATUS_BAR_PRIORITY_LIMIT)
      .optional(),
    /** A command from this plugin's `contributes.commands`, run on click. */
    command: pluginCommandIdSchema.optional(),
    /** A panel from this plugin's `contributes.panels`, opened on click. */
    panel: pluginIdSchema.optional()
  })
  .strict()

export type PluginStatusBarItemContribution = z.infer<typeof pluginStatusBarItemContributionSchema>

// Why: control and bidi-override characters could make plugin text masquerade
// as another segment or push Orca chrome around; the bar is one plain line.
// oxlint-disable-next-line no-control-regex -- Matching control characters is the point.
const UNSAFE_STATUS_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

export function sanitizePluginStatusBarText(value: string): string {
  return value.replace(UNSAFE_STATUS_TEXT_RE, ' ')
}

const statusBarTextSchema = (max: number) =>
  z.string().max(max).transform(sanitizePluginStatusBarText)

export const pluginStatusBarUpdateParamsSchema = z
  .object({
    itemId: pluginIdSchema,
    text: statusBarTextSchema(PLUGIN_STATUS_BAR_TEXT_MAX_LENGTH),
    tooltip: statusBarTextSchema(PLUGIN_STATUS_BAR_TOOLTIP_MAX_LENGTH).optional(),
    severity: z.enum(PLUGIN_STATUS_BAR_SEVERITIES).optional(),
    visible: z.boolean().optional()
  })
  .strict()

export type PluginStatusBarUpdateParams = z.infer<typeof pluginStatusBarUpdateParamsSchema>

/** Latest worker-published state of one item. Every update replaces the
 *  whole state, so omitted fields fall back to their defaults. */
export type PluginStatusBarItemState = {
  text: string
  tooltip?: string
  severity: PluginStatusBarSeverity
  visible: boolean
}

/** Wire shape of `plugins:listStatusBarItems` and its change push: visible
 *  items only, already in render order. */
export type PluginStatusBarItemSnapshot = {
  pluginKey: string
  pluginName: string
  itemId: string
  alignment: 'left' | 'right'
  priority: number
  /** Contributed command id; the renderer resolves it against enabled commands. */
  command?: string
  /** Sidebar tab key of the plugin panel a click opens. */
  panelTabKey?: `plugin:${string}`
  text: string
  tooltip?: string
  severity: PluginStatusBarSeverity
}

export function comparePluginStatusBarItems(
  a: Pick<PluginStatusBarItemSnapshot, 'priority' | 'pluginKey'> & { order: number },
  b: Pick<PluginStatusBarItemSnapshot, 'priority' | 'pluginKey'> & { order: number }
): number {
  if (a.priority !== b.priority) {
    return b.priority - a.priority
  }
  if (a.pluginKey !== b.pluginKey) {
    return a.pluginKey < b.pluginKey ? -1 : 1
  }
  return a.order - b.order
}
