import { z } from 'zod'

const lineOrColumn = z.number().int().min(1)
const rangeSchema = z.object({
  startLineNumber: lineOrColumn,
  startColumn: lineOrColumn,
  endLineNumber: lineOrColumn,
  endColumn: lineOrColumn
})
const hoverSchema = z.object({
  contents: z.string(),
  range: rangeSchema.optional().catch(undefined)
})
const locationSchema = z.object({
  filePath: z.string().min(1),
  range: rangeSchema
})

export type PluginHover = z.infer<typeof hoverSchema>
export type PluginLocation = z.infer<typeof locationSchema>

/** A plugin hover reply, or null when malformed. Why: replies are untrusted and bad ranges throw in Monaco. */
export function parseHover(value: unknown): PluginHover | null {
  const parsed = hoverSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The well-formed entries of a plugin location reply; anything else is dropped. */
export function parseLocations(value: unknown): PluginLocation[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item: unknown) => {
    const parsed = locationSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

/**
 * The target's path relative to the source tab's workspace, or null when the target is outside it.
 * Why: plugin locations are untrusted; following one outside the workspace would read or open
 * any file on the host and hand its text back to the plugin on the next hover.
 */
export function workspaceRelativeTarget(
  tab: { filePath: string; relativePath: string },
  filePath: string
): string | null {
  const root = tab.filePath.slice(0, tab.filePath.length - tab.relativePath.length)
  if (!root || tab.relativePath === tab.filePath || !filePath.startsWith(root)) {
    return null
  }
  const relativePath = filePath.slice(root.length)
  const segments = relativePath.split(/[\\/]/)
  return relativePath && segments.every((segment) => segment && segment !== '.' && segment !== '..')
    ? relativePath
    : null
}
