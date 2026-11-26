import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import type { FileSearchWorktreeState } from '@/store/slices/editor/types/file-search-worktree-state'

/** The draft a worktree's search field should open with: a pending query seed, else the flushed draft. */
export function getInitialSearchDraft(worktreeId: string | null): string {
  const stored = worktreeId
    ? useAppStore.getState().fileSearchStateByWorktree[worktreeId]
    : undefined
  if (stored?.seedRequestId !== undefined && stored.seedKind === 'query') {
    return stored.query
  }
  return stored?.active ? (stored.draft ?? stored.query) : ''
}

/**
 * The field is keyed per worktree: publish whether results cover the tree, flush the draft when the
 * field unmounts (switch, tab change, owner change), and rerun its text search when it comes back.
 */
export function useSearchDraftLifecycle({
  activeWorktreeId,
  query,
  updateActiveSearchState,
  runTextSearch
}: {
  activeWorktreeId: string | null
  query: string
  updateActiveSearchState: (updates: Partial<FileSearchWorktreeState>) => void
  runTextSearch: (query: string) => void
}): void {
  const hasQuery = query.trim().length > 0
  const latestRef = useRef({ activeWorktreeId, query, updateActiveSearchState, runTextSearch })
  latestRef.current = { activeWorktreeId, query, updateActiveSearchState, runTextSearch }

  useEffect(() => {
    latestRef.current.updateActiveSearchState({ active: hasQuery })
  }, [hasQuery])

  useEffect(() => {
    const { activeWorktreeId: worktreeId, query: draft, runTextSearch: run } = latestRef.current
    const stored = worktreeId
      ? useAppStore.getState().fileSearchStateByWorktree[worktreeId]
      : undefined
    // A pending seed runs its own search; current results for this exact draft need no rescan.
    const hasCurrentResults = stored?.query === draft && stored.results !== null
    if (draft.trim() && stored?.seedRequestId === undefined && !hasCurrentResults) {
      run(draft)
    }
    return () => {
      const { query: finalDraft, updateActiveSearchState } = latestRef.current
      updateActiveSearchState({ draft: finalDraft, active: finalDraft.trim().length > 0 })
    }
  }, [])
}
