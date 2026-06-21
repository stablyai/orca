export type FileSearchSelectedTextProvider = () => string | null | undefined
export const FILE_SEARCH_SELECTED_TEXT_MAX_CHARS = 2 * 1024

const LINE_FEED_CODE_UNIT = 10
const CARRIAGE_RETURN_CODE_UNIT = 13

type ProviderEntry = {
  id: number
  provider: FileSearchSelectedTextProvider
}

const selectedTextProviders: ProviderEntry[] = []
let nextProviderId = 1

export function normalizeSelectedTextForFileSearch(text: string | null | undefined): string | null {
  if (!text) {
    return null
  }
  let normalized = ''
  let lineStart = 0
  for (let index = 0; index <= text.length; index += 1) {
    const codeUnit = index < text.length ? text.charCodeAt(index) : LINE_FEED_CODE_UNIT
    if (
      index < text.length &&
      codeUnit !== LINE_FEED_CODE_UNIT &&
      codeUnit !== CARRIAGE_RETURN_CODE_UNIT
    ) {
      continue
    }
    normalized = appendSelectedTextSearchLine(normalized, text, lineStart, index)
    if (normalized.length >= FILE_SEARCH_SELECTED_TEXT_MAX_CHARS) {
      break
    }
    if (
      codeUnit === CARRIAGE_RETURN_CODE_UNIT &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) === LINE_FEED_CODE_UNIT
    ) {
      index += 1
    }
    lineStart = index + 1
  }
  return normalized.length > 0 ? normalized : null
}

function appendSelectedTextSearchLine(
  current: string,
  text: string,
  lineStart: number,
  lineEnd: number
): string {
  const trimmedStart = findSelectedTextLineTrimStart(text, lineStart, lineEnd)
  const trimmedEnd = findSelectedTextLineTrimEnd(text, trimmedStart, lineEnd)
  if (trimmedStart >= trimmedEnd) {
    return current
  }
  const prefix = current.length > 0 ? ' ' : ''
  const remaining = FILE_SEARCH_SELECTED_TEXT_MAX_CHARS - current.length - prefix.length
  if (remaining <= 0) {
    return current
  }
  return `${current}${prefix}${text.slice(trimmedStart, Math.min(trimmedEnd, trimmedStart + remaining))}`
}

function findSelectedTextLineTrimStart(text: string, lineStart: number, lineEnd: number): number {
  let index = lineStart
  while (index < lineEnd && text[index]?.trim() === '') {
    index += 1
  }
  return index
}

function findSelectedTextLineTrimEnd(text: string, lineStart: number, lineEnd: number): number {
  let index = lineEnd
  while (index > lineStart && text[index - 1]?.trim() === '') {
    index -= 1
  }
  return index
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
