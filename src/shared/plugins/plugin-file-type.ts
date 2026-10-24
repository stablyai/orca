import { z } from 'zod'

/** A file extension without its dot, as catalogs list it. */
export const pluginFileTypeSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9+_-]{0,15}$/, 'must be a lowercase extension without the dot')

const MAX_DISMISSED_FILE_TYPES = 256

/** The last extension of a path, lowercased; null for dotfiles and names without one. */
export function fileTypeOfPath(filePath: string): string | null {
  const name = filePath.split(/[\\/]/).at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) {
    return null
  }
  const fileType = name.slice(dot + 1).toLowerCase()
  return pluginFileTypeSchema.safeParse(fileType).success ? fileType : null
}

export type PluginFileTypeSuggestionSettings = {
  /** Off stops suggesting plugins for files Orca can't highlight or open. Absent means on. */
  pluginFileTypeSuggestions?: boolean
  /** File types the user chose never to get a suggestion for. */
  pluginDismissedFileTypes?: string[]
}

/** Unvalidated suggestion keys as a settings write or load carries them. */
export type PluginFileTypeSuggestionSettingsInput = {
  [Key in keyof PluginFileTypeSuggestionSettings]?: unknown
}

/** Bounds the suggestion settings on every write and load; only keys present in `input` return. */
export function normalizePluginFileTypeSuggestionSettings(
  input: PluginFileTypeSuggestionSettingsInput
): Partial<PluginFileTypeSuggestionSettings> {
  const result: Partial<PluginFileTypeSuggestionSettings> = {}
  if ('pluginFileTypeSuggestions' in input) {
    result.pluginFileTypeSuggestions = input.pluginFileTypeSuggestions !== false
  }
  if ('pluginDismissedFileTypes' in input) {
    const value = input.pluginDismissedFileTypes
    const valid = Array.isArray(value)
      ? value.filter((entry): entry is string => pluginFileTypeSchema.safeParse(entry).success)
      : []
    const newest = new Set<string>()
    for (const fileType of valid) {
      // Why delete first: a repeat moves to the end, so the newest dismissals survive the cap.
      newest.delete(fileType)
      newest.add(fileType)
    }
    result.pluginDismissedFileTypes = [...newest].slice(-MAX_DISMISSED_FILE_TYPES)
  }
  return result
}
