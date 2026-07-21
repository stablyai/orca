import type { IRange } from 'monaco-editor'

export type MonacoSelectionStats = {
  chars: number
  words: number
}

type MonacoSelectionStatsModel = {
  getValueInRange: (range: IRange) => string
}

function isEmptyRange(range: IRange): boolean {
  return range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn
}

function countChars(text: string): number {
  return Array.from(text).length
}

function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) {
    return 0
  }
  return trimmed.split(/\s+/u).length
}

export function getMonacoSelectionStats(
  model: MonacoSelectionStatsModel | null,
  selections: IRange[] | null
): MonacoSelectionStats | null {
  if (!model || !selections || selections.length === 0) {
    return null
  }
  let chars = 0
  let words = 0
  let hasContent = false
  for (const selection of selections) {
    if (isEmptyRange(selection)) {
      continue
    }
    const text = model.getValueInRange(selection)
    if (!text) {
      continue
    }
    hasContent = true
    chars += countChars(text)
    words += countWords(text)
  }
  return hasContent ? { chars, words } : null
}
