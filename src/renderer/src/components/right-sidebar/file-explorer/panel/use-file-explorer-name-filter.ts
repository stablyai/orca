import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useMemo, useState } from 'react'
import {
  useRuntimeFileListForWorktree,
  type RuntimeFileListState
} from '@/components/quick-open-file-list'
import {
  isFileExplorerNameFilterQueryTooLarge,
  type FileExplorerNameFilterProjectionSource
} from '../tree/file-explorer-name-filter-projection'

type UseFileExplorerNameFilterResult = {
  nameFilterQuery: string
  setNameFilterQuery: Dispatch<SetStateAction<string>>
  nameFilterCollapsedPaths: Set<string>
  setNameFilterCollapsedPaths: Dispatch<SetStateAction<Set<string>>>
  hasNameFilter: boolean
  nameFilterFiles: RuntimeFileListState
  nameFilterSource: FileExplorerNameFilterProjectionSource | null
  handleClearNameFilter: () => void
}

export function useFileExplorerNameFilter({
  isFilesViewActive,
  activeWorktreeId
}: {
  isFilesViewActive: boolean
  activeWorktreeId: string | null
}): UseFileExplorerNameFilterResult {
  const [nameFilterQuery, setNameFilterQuery] = useState('')
  const [nameFilterCollapsedPaths, setNameFilterCollapsedPaths] = useState<Set<string>>(
    () => new Set()
  )
  const hasNameFilterQuery = nameFilterQuery.trim().length > 0
  const nameFilterQueryTooLarge = useMemo(
    () => isFileExplorerNameFilterQueryTooLarge(nameFilterQuery),
    [nameFilterQuery]
  )
  const hasNameFilter = isFilesViewActive && hasNameFilterQuery
  // Clear on deactivation during render so the tree never commits stale filter collapses.
  const [prevHasNameFilter, setPrevHasNameFilter] = useState(hasNameFilter)
  if (prevHasNameFilter !== hasNameFilter) {
    setPrevHasNameFilter(hasNameFilter)
    if (!hasNameFilter && nameFilterCollapsedPaths.size > 0) {
      setNameFilterCollapsedPaths(new Set())
    }
  }
  const nameFilterFiles = useRuntimeFileListForWorktree({
    enabled: hasNameFilter && !nameFilterQueryTooLarge,
    worktreeId: activeWorktreeId,
    query: nameFilterQuery,
    hostFilterWhenCapped: true
  })
  const nameFilterSource = useMemo(
    () =>
      hasNameFilter
        ? {
            query: nameFilterQuery,
            operationOwner: nameFilterFiles.operationOwner,
            relativePaths: nameFilterQueryTooLarge
              ? []
              : nameFilterFiles.loading
                ? null
                : nameFilterFiles.files
          }
        : null,
    [
      hasNameFilter,
      nameFilterFiles.files,
      nameFilterFiles.loading,
      nameFilterFiles.operationOwner,
      nameFilterQuery,
      nameFilterQueryTooLarge
    ]
  )
  const handleClearNameFilter = useCallback(() => {
    setNameFilterQuery('')
  }, [setNameFilterQuery])

  return {
    nameFilterQuery,
    setNameFilterQuery,
    nameFilterCollapsedPaths,
    setNameFilterCollapsedPaths,
    hasNameFilter,
    nameFilterFiles,
    nameFilterSource,
    handleClearNameFilter
  }
}
