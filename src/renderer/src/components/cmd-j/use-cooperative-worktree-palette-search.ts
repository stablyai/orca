import { useEffect, useMemo, useState } from 'react'
import {
  searchWorktreeDocuments,
  searchWorktreeDocumentsCooperatively,
  type PaletteSearchResult,
  type WorktreePaletteSearchArgs
} from '@/lib/worktree-palette-search'
import { parseCmdJTaskSourceUrl } from '@/lib/worktree-palette-task-url-match'

const COOPERATIVE_SEARCH_MIN_WORKTREES = 200

type CompletedSearch =
  | {
      request: WorktreePaletteSearchArgs
      results: PaletteSearchResult[]
    }
  | { request: WorktreePaletteSearchArgs; error: unknown }

type CooperativeWorktreePaletteSearch = {
  pending: boolean
  results: PaletteSearchResult[]
}

export function useCooperativeWorktreePaletteSearch(
  args: WorktreePaletteSearchArgs & { documentsPending?: boolean }
): CooperativeWorktreePaletteSearch {
  const {
    worktrees,
    query,
    documents,
    documentsPending = false,
    repoMap,
    repoMapByHostIdentity,
    checksReviewByWorktree
  } = args
  const request = useMemo<WorktreePaletteSearchArgs>(
    () => ({
      worktrees,
      query,
      documents,
      repoMap,
      repoMapByHostIdentity,
      checksReviewByWorktree
    }),
    [worktrees, query, documents, repoMap, repoMapByHostIdentity, checksReviewByWorktree]
  )
  const cooperative =
    request.worktrees.length >= COOPERATIVE_SEARCH_MIN_WORKTREES &&
    request.query.trim().length > 0 &&
    parseCmdJTaskSourceUrl(request.query.trim()) === null
  const waitingForDocuments =
    documentsPending &&
    request.query.trim().length > 0 &&
    parseCmdJTaskSourceUrl(request.query.trim()) === null
  const immediateResults = useMemo(
    () => (cooperative || waitingForDocuments ? null : searchWorktreeDocuments(request)),
    [cooperative, request, waitingForDocuments]
  )
  const [completed, setCompleted] = useState<CompletedSearch | null>(null)

  useEffect(() => {
    if (!cooperative || waitingForDocuments) {
      return
    }
    let current = true
    void searchWorktreeDocumentsCooperatively(request, {
      shouldContinue: () => current
    }).then(
      (results) => {
        if (current && results) {
          setCompleted({ request, results })
        }
      },
      (error: unknown) => {
        if (current) {
          setCompleted({ request, error })
        }
      }
    )
    return () => {
      current = false
    }
  }, [cooperative, request, waitingForDocuments])

  if (immediateResults) {
    return { pending: false, results: immediateResults }
  }
  if (completed?.request !== request) {
    return { pending: true, results: [] }
  }
  if ('error' in completed) {
    throw completed.error
  }
  return { pending: false, results: completed.results }
}
