import type { CustomLanguage } from '../../../shared/custom-languages'

let filenames = new Map<string, string>()
let extensions: [string, string][] = []

export function setCustomLanguageAssociations(languages: CustomLanguage[]): void {
  filenames = new Map()
  const extensionMap = new Map<string, string>()
  for (const language of languages) {
    for (const filename of language.filenames ?? []) {
      if (!filenames.has(filename)) {
        filenames.set(filename, language.id)
      }
    }
    for (const extension of language.extensions ?? []) {
      const normalized = extension.toLowerCase()
      if (!extensionMap.has(normalized)) {
        extensionMap.set(normalized, language.id)
      }
    }
  }
  extensions = [...extensionMap].sort(([left], [right]) => right.length - left.length)
}

export function detectCustomLanguage(filePath: string): string | undefined {
  const filename = filePath.split(/[\\/]/).at(-1) ?? ''
  const exact = filenames.get(filename)
  if (exact) {
    return exact
  }
  const lower = filename.toLowerCase()
  return extensions.find(([extension]) => lower.endsWith(extension))?.[1]
}
