import { useCallback, useMemo, useState } from 'react'
import {
  useRuntimeFileListForWorktree,
  type RuntimeFileListState
} from '@/components/file-actions/quick-open/quick-open-file-list'
import {
  findNameMatches,
  isNameFilterQueryTooLarge,
  NAME_MATCH_PREVIEW_LIMIT,
  type NameMatchResults
} from '../combined-search/name-match-results'

const NO_NAME_MATCHES: NameMatchResults = { total: 0, matches: [] }

type UseFileExplorerNameFilterResult = {
  hasNameFilterQuery: boolean
  nameFilterFiles: RuntimeFileListState
  /** null while the listing for this query is loading. */
  nameMatches: NameMatchResults | null
  showAllNameMatches: () => void
}

/** Name half of the combined search: the same listing request as the old name filter, projected to flat ranked rows. */
export function useFileExplorerNameFilter({
  query,
  activeWorktreeId,
  worktreePath,
  displayRootPath,
  showDotfiles
}: {
  query: string
  activeWorktreeId: string | null
  worktreePath: string | null
  displayRootPath: string | null
  showDotfiles: boolean
}): UseFileExplorerNameFilterResult {
  const hasNameFilterQuery = query.trim().length > 0
  const queryTooLarge = useMemo(() => isNameFilterQueryTooLarge(query), [query])
  const nameFilterFiles = useRuntimeFileListForWorktree({
    enabled: hasNameFilterQuery && !queryTooLarge,
    worktreeId: activeWorktreeId,
    query,
    hostFilterWhenCapped: true
  })
  const [showAllQuery, setShowAllQuery] = useState<string | null>(null)
  const showAll = showAllQuery === query
  const { files, loading } = nameFilterFiles
  const nameMatches = useMemo(() => {
    if (!hasNameFilterQuery || !worktreePath) {
      return null
    }
    if (queryTooLarge) {
      return NO_NAME_MATCHES
    }
    if (loading) {
      return null
    }
    return findNameMatches({
      relativePaths: files,
      query,
      worktreePath,
      displayRootPath: displayRootPath ?? worktreePath,
      showDotfiles,
      limit: showAll ? null : NAME_MATCH_PREVIEW_LIMIT
    })
  }, [
    displayRootPath,
    files,
    hasNameFilterQuery,
    loading,
    query,
    queryTooLarge,
    showAll,
    showDotfiles,
    worktreePath
  ])
  const showAllNameMatches = useCallback(() => setShowAllQuery(query), [query])

  return { hasNameFilterQuery, nameFilterFiles, nameMatches, showAllNameMatches }
}
