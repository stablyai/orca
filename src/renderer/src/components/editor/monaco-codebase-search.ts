import type { IPosition, IRange } from 'monaco-editor'
import { normalizeSelectedTextForFileSearch } from '@/lib/file-search-selection'

type MonacoCodebaseSearchModel = {
  getValueInRange: (range: IRange) => string
  getWordAtPosition: (position: IPosition) => { word: string } | null
}

type MonacoCodebaseSearchSelection = IRange & {
  isEmpty: () => boolean
}

export function getMonacoCodebaseSearchQuery(
  model: MonacoCodebaseSearchModel | null,
  selection: MonacoCodebaseSearchSelection | null,
  position: IPosition | null
): string | null {
  if (!model) {
    return null
  }

  if (selection && !selection.isEmpty()) {
    const selectedQuery = normalizeSelectedTextForFileSearch(model.getValueInRange(selection))
    if (selectedQuery) {
      return selectedQuery
    }
  }

  if (!position) {
    return null
  }

  // Why: until Orca has semantic LSP references, the editor affordance should
  // still work from a cursor by searching the visible symbol text in files.
  return normalizeSelectedTextForFileSearch(model.getWordAtPosition(position)?.word)
}
