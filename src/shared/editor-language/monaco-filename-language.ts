import associations from './monaco-language-associations.json'

// Generated metadata avoids importing Monaco during session restoration.
const filenames = new Map<string, string>()
const extensions = new Map<string, string>()
// Like Monaco, later registrations win ambiguous associations such as .pp.
for (const language of associations) {
  for (const filename of language.filenames) {
    filenames.set(filename.toLowerCase(), language.id)
  }
  for (const extension of language.extensions) {
    extensions.set(extension.toLowerCase(), language.id)
  }
}
const suffixes = [...extensions.keys()].sort((a, b) => b.length - a.length)

export function detectMonacoFilenameLanguage(filename: string): string | undefined {
  const lowerName = filename.toLowerCase()
  const exact = filenames.get(lowerName)
  if (exact) {
    return exact
  }
  const suffix = suffixes.find((extension) => lowerName.endsWith(extension))
  return suffix ? extensions.get(suffix) : undefined
}
