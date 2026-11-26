import type React from 'react'
import type { CombinedSearchRow, CombinedSearchRowModel } from './combined-search-rows'

export type CombinedSearchFieldState = {
  query: string
  loading: boolean
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
  activeDescendantId: string | undefined
  onQueryChange: (value: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  onClear: () => void
  onToggleCaseSensitive: () => void
  onToggleWholeWord: () => void
  onToggleRegex: () => void
}

export type CombinedSearchResultsState = {
  model: CombinedSearchRowModel
  activeIndex: number
  listboxId: string
  onActivateRow: (row: CombinedSearchRow, index: number, permanent?: boolean) => void
}
