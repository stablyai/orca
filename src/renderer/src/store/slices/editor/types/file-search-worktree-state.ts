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
  focusRequestId?: number
}
