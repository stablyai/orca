import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import type { FileSearchResultOwner } from '@/lib/file-search-result-owner'
import { useAppStore } from '@/store'
import type { FileSearchWorktreeState } from '@/store/slices/editor/types/file-search-worktree-state'
import type {
  SearchFileResult,
  SearchMatch,
  SearchResult
} from '../../../../shared/code-search-types'
import {
  captureFileExplorerOperationGuard,
  getFileExplorerOperationOwner
} from './file-explorer-operation-owner'
import { replaceInSearchFiles, type SearchReplaceFileJob } from './search-replace-files'
import { reportSearchReplaceSummary, searchReplaceAllConfirmation } from './search-replace-messages'
import { compileSearchReplace, type CompiledSearchReplace } from './search-replace-text'
import type { SearchReplaceRowProps } from './SearchReplaceRow'

export type SearchResultsReplaceProps = {
  compiled: CompiledSearchReplace | null
  /** False while a search or replace is pending, so actions never run against stale results. */
  canReplace: boolean
  onReplaceFile: (fileResult: SearchFileResult) => void
  onReplaceMatch: (fileResult: SearchFileResult, match: SearchMatch) => void
}

export type FileSearchReplaceModel = {
  replaceVisible: boolean
  onToggleReplace: () => void
  replaceRowProps: SearchReplaceRowProps
  /** Present while the replace input is shown. */
  resultsReplace: SearchResultsReplaceProps | undefined
}

export function useFileSearchReplace({
  activeWorktreeId,
  worktreePath,
  searchState,
  results,
  resultOwner,
  updateActiveSearchState,
  rerunSearch
}: {
  activeWorktreeId: string | null
  worktreePath: string | null
  searchState: FileSearchWorktreeState | null | undefined
  results: SearchResult | null
  resultOwner: FileSearchResultOwner | null
  updateActiveSearchState: (updates: Partial<FileSearchWorktreeState>) => void
  rerunSearch: () => void
}): FileSearchReplaceModel {
  const confirm = useConfirmationDialog()
  const [replacing, setReplacing] = useState(false)
  const replacingRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const replaceVisible = searchState?.replaceVisible ?? false
  const replaceText = searchState?.replaceText ?? ''
  const preserveCase = searchState?.preserveCase ?? false
  const resultsQuery = searchState?.resultsQuery ?? null
  const searchLoading = searchState?.loading ?? false

  // Why: compile the query that produced the shown results, not the one being typed.
  const { compiled, compileError } = useMemo(() => {
    if (!replaceVisible || !resultsQuery?.query) {
      return { compiled: null, compileError: null }
    }
    try {
      return {
        compiled: compileSearchReplace(resultsQuery, replaceText, preserveCase),
        compileError: null
      }
    } catch {
      return {
        compiled: null,
        compileError: translate(
          'auto.components.right.sidebar.SearchReplace.unsupportedRegex',
          'Replace does not support this regular expression.'
        )
      }
    }
  }, [resultsQuery, replaceVisible, replaceText, preserveCase])
  const canReplace = compiled !== null && !searchLoading && !replacing

  const runReplace = useCallback(
    async (jobs: SearchReplaceFileJob[], announce: boolean): Promise<void> => {
      if (
        replacingRef.current ||
        !compiled ||
        !activeWorktreeId ||
        !worktreePath ||
        !resultOwner ||
        jobs.length === 0 ||
        // Why: a search started after the confirm dialog opened makes these jobs stale.
        useAppStore.getState().fileSearchStateByWorktree[activeWorktreeId]?.loading
      ) {
        return
      }
      replacingRef.current = true
      setReplacing(true)
      try {
        const guard = captureFileExplorerOperationGuard(
          activeWorktreeId,
          getFileExplorerOperationOwner(activeWorktreeId)
        )
        const summary = await replaceInSearchFiles(
          {
            worktreeId: activeWorktreeId,
            worktreePath,
            runtimeEnvironmentId: resultOwner.runtimeEnvironmentId,
            guard,
            compiled
          },
          jobs
        )
        reportSearchReplaceSummary(summary, replaceText, announce)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      } finally {
        replacingRef.current = false
        setReplacing(false)
        rerunSearch()
      }
    },
    [activeWorktreeId, compiled, replaceText, rerunSearch, resultOwner, worktreePath]
  )

  const replaceAll = useCallback(() => {
    if (!results || results.files.length === 0 || !compiled) {
      return
    }
    void (async () => {
      if (await confirm(searchReplaceAllConfirmation(results, replaceText))) {
        await runReplace(
          results.files.map((fileResult) => ({ fileResult })),
          true
        )
      }
    })()
  }, [compiled, confirm, replaceText, results, runReplace])

  const onReplaceFile = useCallback(
    (fileResult: SearchFileResult) => void runReplace([{ fileResult }], false),
    [runReplace]
  )

  const onReplaceMatch = useCallback(
    (fileResult: SearchFileResult, match: SearchMatch) =>
      void runReplace(
        [
          {
            fileResult,
            targets: [{ line: match.line, column: match.column, matchLength: match.matchLength }]
          }
        ],
        false
      ),
    [runReplace]
  )

  const onToggleReplace = useCallback(() => {
    updateActiveSearchState({ replaceVisible: !replaceVisible })
    if (!replaceVisible) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [replaceVisible, updateActiveSearchState])

  const resultsReplace = useMemo(
    () => (replaceVisible ? { compiled, canReplace, onReplaceFile, onReplaceMatch } : undefined),
    [canReplace, compiled, onReplaceFile, onReplaceMatch, replaceVisible]
  )

  return {
    replaceVisible,
    onToggleReplace,
    replaceRowProps: {
      inputRef,
      replaceText,
      preserveCase,
      canReplaceAll: canReplace && (results?.files.length ?? 0) > 0,
      error: compileError,
      replacing,
      onReplaceTextChange: (value) => updateActiveSearchState({ replaceText: value }),
      onTogglePreserveCase: () => updateActiveSearchState({ preserveCase: !preserveCase }),
      onReplaceAll: replaceAll
    },
    resultsReplace
  }
}
