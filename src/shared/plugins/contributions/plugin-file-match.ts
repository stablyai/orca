import { z } from 'zod'
import { pluginFieldDoc } from '../manifest/plugin-schema-field-docs'

const PLUGIN_FILE_MATCH_LIMIT = 32

/** A file-name suffix with its dot: `.gleam`, or a compound one like `.excalidraw.json`. */
export const pluginFileExtensionSchema = z
  .string()
  .max(64)
  .regex(/^\.[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*$/, 'must look like .ext')

export const pluginFileNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (name) =>
      name !== '.' &&
      name !== '..' &&
      !/[<>:"/\\|?*]/.test(name) &&
      Array.from(name).every((character) => character.charCodeAt(0) >= 32),
    'must be a portable file name'
  )

/** The one file matcher syntaxes and custom editors share. `subject` names what opens the files. */
export function pluginFileMatchFields(
  subject: string,
  since: string,
  examples: { extensions: string[]; filenames: string[] }
) {
  return {
    extensions: z
      .array(pluginFileExtensionSchema)
      .max(PLUGIN_FILE_MATCH_LIMIT)
      .default([])
      .meta(
        pluginFieldDoc(
          `File-name suffixes, with the dot, ${subject} opens, ignoring case. A longer suffix such as \`.excalidraw.json\` wins over a shorter one, and a file named only the suffix never matches. At most ${PLUGIN_FILE_MATCH_LIMIT}.`,
          since,
          [examples.extensions]
        )
      ),
    filenames: z
      .array(pluginFileNameSchema)
      .max(PLUGIN_FILE_MATCH_LIMIT)
      .default([])
      .meta(
        pluginFieldDoc(
          `Exact file names ${subject} opens, ignoring case; a name beats any extension. Names must be portable: no path separators, \`.\`, \`..\` or characters Windows forbids. At most ${PLUGIN_FILE_MATCH_LIMIT}.`,
          since,
          [examples.filenames]
        )
      )
  }
}

export type PluginFileMatch = {
  extensions: readonly string[]
  filenames: readonly string[]
}

/** How a file matched: its exact name, or the longest listed extension (lowercased, with dot). */
export type PluginFileMatchResult = { by: 'filename' } | { by: 'extension'; extension: string }

export function pluginFileBaseName(filePath: string): string {
  return (filePath.split(/[\\/]/).at(-1) ?? '').toLowerCase()
}

export function matchPluginFile(
  filePath: string,
  match: PluginFileMatch
): PluginFileMatchResult | null {
  const name = pluginFileBaseName(filePath)
  if (match.filenames.some((filename) => filename.toLowerCase() === name)) {
    return { by: 'filename' }
  }
  let best: string | null = null
  for (const listed of match.extensions) {
    const extension = listed.toLowerCase()
    if (name.length > extension.length && name.endsWith(extension)) {
      if (best === null || extension.length > best.length) {
        best = extension
      }
    }
  }
  return best === null ? null : { by: 'extension', extension: best }
}

/** Ranks matches across contributions: any exact name, then the longest extension. */
export function pluginFileMatchRank(result: PluginFileMatchResult | null): number {
  if (result === null) {
    return 0
  }
  return result.by === 'filename' ? Number.MAX_SAFE_INTEGER : result.extension.length
}
