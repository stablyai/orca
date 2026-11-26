import type { SearchResult } from '../../../../../../shared/file-search/code-search-types'
import type { FileSearchResultOwner } from '@/lib/files/search/file-search-result-owner'

export type FileSearchWorktreeState = {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
  includePattern: string
  excludePattern: string
  results: SearchResult | null
  resultOwner: FileSearchResultOwner | null
  error?: string | null
  loading: boolean
  collapsedFiles: Set<string>
  seedRequestId?: number
  /** A query seed replaces the field's draft; a filters seed reruns the draft with new include/exclude. */
  seedKind?: 'query' | 'filters'
  focusRequestId?: number
  /** In memory: the Files query is non-empty, so search results cover the tree. */
  active?: boolean
  /** In memory: the field's text when it unmounted; `query` stays the last searched text. */
  draft?: string
}
