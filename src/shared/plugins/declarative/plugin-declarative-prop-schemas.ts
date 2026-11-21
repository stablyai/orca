import { z } from 'zod'
import { PLUGIN_DECLARATIVE_LIMITS as LIMITS } from './plugin-declarative-limits'
import { PLUGIN_DECLARATIVE_EDIT_PROP } from './plugin-declarative-message-names'

/** Building blocks every catalog component's props are made of. */

export const PLUGIN_DECLARATIVE_CALLBACK_ID = /^[A-Za-z0-9_.:-]+$/
export const pluginDeclarativeCallbackSchema = z
  .object({
    $callback: z
      .string()
      .min(1)
      .max(LIMITS.maxCallbackIdLength)
      .regex(PLUGIN_DECLARATIVE_CALLBACK_ID)
  })
  .strict()
export type PluginDeclarativeCallback = z.infer<typeof pluginDeclarativeCallbackSchema>

/** The one colour vocabulary every component shares. */
export const PLUGIN_DECLARATIVE_TONES = [
  'neutral',
  'accent',
  'success',
  'warning',
  'danger'
] as const

export const label = z.string().max(LIMITS.maxLabelLength)
export const requiredLabel = label.min(1)
export const callback = pluginDeclarativeCallbackSchema.optional()
// Why any short name: an unknown icon falls back to a glyph instead of rejecting the render.
export const icon = z.string().regex(/^[a-z0-9-]{1,64}$/)
export const gap = z.enum(['none', 'xs', 'sm', 'md', 'lg']).optional()
export const align = z.enum(['start', 'center', 'end', 'stretch']).optional()
export const tone = z.enum(PLUGIN_DECLARATIVE_TONES).optional()
export const size = z.enum(['xs', 'sm', 'md']).optional()
export const variant = z.enum(['solid', 'outline', 'ghost']).optional()
export const flag = z.boolean().optional()
export const text = z.string().max(LIMITS.maxTextLength)
/** A fixed-height scroll area for long content, so it does not push the rest of the panel away. */
export const maxHeight = z.enum(['sm', 'md', 'lg', 'none']).optional()
/** A row or item identity: what selection, sorting and events name. */
export const itemKey = z.string().min(1).max(LIMITS.maxLabelLength)
/** Wire-only on value controls (see PLUGIN_DECLARATIVE_EDIT_PROP); authors never set it. */
export const editAck = {
  [PLUGIN_DECLARATIVE_EDIT_PROP]: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
}

/** What a component accepts as children: `inline` is text plus Text/Link/Code/Badge; `items`,
 *  `tabs` hold only their one child type (ListItem, Tab). */
export type PluginDeclarativeChildPolicy = 'none' | 'text' | 'inline' | 'items' | 'tabs' | 'any'

export function component<P extends z.ZodObject>(props: P, children: PluginDeclarativeChildPolicy) {
  return { props, children }
}
