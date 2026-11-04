import type { SearchResult } from '../../../../../../shared/code-search-types'
import type { FileSearchResultOwner } from '@/lib/file-search-result-owner'

/** The query and options that produced `results`. */
export type FileSearchResultsQuery = {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
}

export type FileSearchWorktreeState = {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
  includePattern: string
  excludePattern: string
  results: SearchResult | null
  resultOwner: FileSearchResultOwner | null
  resultsQuery?: FileSearchResultsQuery | null
  error?: string | null
  loading: boolean
  collapsedFiles: Set<string>
  replaceVisible?: boolean
  replaceText?: string
  preserveCase?: boolean
  seedRequestId?: number
  focusRequestId?: number
}
