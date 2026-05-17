export type FileSearchSelectedTextProvider = () => string | null | undefined

type ProviderEntry = {
  id: number
  provider: FileSearchSelectedTextProvider
}

const selectedTextProviders: ProviderEntry[] = []
let nextProviderId = 1

export function normalizeSelectedTextForFileSearch(text: string | null | undefined): string | null {
  const trimmed = text?.replace(/\r\n?/g, '\n').trim()
  if (!trimmed) {
    return null
  }
  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
}

export function registerFileSearchSelectedTextProvider(
  provider: FileSearchSelectedTextProvider
): () => void {
  const entry = { id: nextProviderId++, provider }
  selectedTextProviders.push(entry)
  return () => {
    const index = selectedTextProviders.findIndex((candidate) => candidate.id === entry.id)
    if (index !== -1) {
      selectedTextProviders.splice(index, 1)
    }
  }
}

export function getSelectedTextForFileSearch(): string | null {
  for (let index = selectedTextProviders.length - 1; index >= 0; index -= 1) {
    const selectedText = normalizeSelectedTextForFileSearch(selectedTextProviders[index].provider())
    if (selectedText) {
      return selectedText
    }
  }

  if (typeof window === 'undefined') {
    return null
  }

  return normalizeSelectedTextForFileSearch(window.getSelection()?.toString())
}
