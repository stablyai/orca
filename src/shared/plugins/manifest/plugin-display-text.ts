import type { z } from 'zod'
import { stripUnsafeDisplayCharacters } from '../../display-text-safety'

const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g
/** Manifest and catalog keys whose strings Orca shows as plugin names, titles and listing text. */
const DISPLAY_TEXT_KEYS = new Set(['name', 'title', 'displayName', 'description', 'label'])

/** Plugin text as Orca may show it: one line, with nothing that reorders or hides characters. */
export function sanitizePluginDisplayText(value: string): string {
  return stripUnsafeDisplayCharacters(value.replace(LINE_BREAKS, ' '))
}

/** Hosts strip unsafe characters so an installed plugin keeps loading; `validate:plugin` refuses
 *  them through `unsafePluginDisplayTextPaths`. */
export function safePluginDisplayText(schema: z.ZodString): z.ZodString {
  // Why overwrite, not transform: the published JSON Schema keeps its defaults and examples.
  const safe = schema.overwrite(sanitizePluginDisplayText)
  // Why re-check: text made only of stripped characters must not become an empty name.
  return schema.minLength ? safe.min(schema.minLength, 'must contain visible characters') : safe
}

/** Dotted paths of display strings in a raw manifest or catalog that Orca would have to change. */
export function unsafePluginDisplayTextPaths(raw: unknown, path = ''): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((item, index) => unsafePluginDisplayTextPaths(item, `${path}[${index}]`))
  }
  if (typeof raw !== 'object' || raw === null) {
    return []
  }
  return Object.entries(raw).flatMap(([key, value]) => {
    const at = path ? `${path}.${key}` : key
    if (typeof value === 'string') {
      return DISPLAY_TEXT_KEYS.has(key) && sanitizePluginDisplayText(value) !== value ? [at] : []
    }
    return unsafePluginDisplayTextPaths(value, at)
  })
}

export const UNSAFE_PLUGIN_DISPLAY_TEXT_MESSAGE =
  'must be one line without control, bidirectional or zero-width characters'
