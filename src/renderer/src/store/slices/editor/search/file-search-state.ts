import type { FileSearchWorktreeState } from '../types/file-search-worktree-state'

const DEFAULT_FILE_SEARCH_STATE = {
  query: '',
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  includePattern: '',
  excludePattern: '',
  results: null,
  resultOwner: null,
  loading: false,
  collapsedFiles: new Set<string>()
} satisfies Omit<FileSearchWorktreeState, 'seedRequestId' | 'focusRequestId'>

export function defaultFileSearchState(): FileSearchWorktreeState {
  return { ...DEFAULT_FILE_SEARCH_STATE, collapsedFiles: new Set<string>() }
}
