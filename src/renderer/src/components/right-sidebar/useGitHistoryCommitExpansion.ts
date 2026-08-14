import { useCallback, useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { GitHistoryItem, GitHistoryResult } from '../../../../shared/git-history'
import type { GitBranchChangeEntry } from '../../../../shared/git-diff-compare-types'
import type { GitHistoryCommitFilesState } from './GitHistoryCommitFiles'

// `worktreeId` rides along with the caches so a load that completes after a worktree switch can
// tell that its result is no longer wanted.
type CommitExpansion = {
  worktreeId: string | undefined
  expanded: Set<string>
  filesByCommit: Record<string, GitHistoryCommitFilesState>
}

type GitHistoryCommitExpansion = {
  expanded: Set<string>
  filesByCommit: Record<string, GitHistoryCommitFilesState>
  toggleExpand: (item: GitHistoryItem) => void
}

function emptyExpansion(worktreeId: string | undefined): CommitExpansion {
  return { worktreeId, expanded: new Set(), filesByCommit: {} }
}

// A commit's file list is already loaded or in flight; re-expanding must not refetch it.
function isCommitFilesResolved(state: GitHistoryCommitFilesState | undefined): boolean {
  return state?.status === 'loading' || state?.status === 'ready'
}

// Per-commit expansion and file-list state for the history panel. Extracted from
// GitHistoryPanel to keep that component from growing.
export function useGitHistoryCommitExpansion({
  result,
  worktreeId,
  onLoadCommitFiles
}: {
  result: GitHistoryResult | undefined
  worktreeId: string | undefined
  onLoadCommitFiles?: (item: GitHistoryItem) => Promise<GitBranchChangeEntry[]>
}): GitHistoryCommitExpansion {
  const [expansion, setExpansion] = useState<CommitExpansion>(() => emptyExpansion(worktreeId))

  // The commit-compare cache in useGitHistoryCommitActions is dropped whenever the worktree
  // changes, so keep this state on the same lifetime — a row retained across the switch would
  // still look expanded while its file clicks resolved to nothing. Reset during render rather
  // than in an effect so the switch never paints a row that is already dead.
  if (expansion.worktreeId !== worktreeId) {
    setExpansion(emptyExpansion(worktreeId))
  }

  // Prune to the commits that survived the new result. Clearing wholesale would collapse every
  // expanded row on Load more, which only appends; file lists are keyed by immutable commit id,
  // so a surviving id cannot show stale files.
  useEffect(() => {
    const liveIds = new Set(result?.items.map((item) => item.id) ?? [])
    setExpansion((prev) => {
      const expanded = new Set([...prev.expanded].filter((id) => liveIds.has(id)))
      const kept = Object.entries(prev.filesByCommit).filter(([id]) => liveIds.has(id))
      if (
        expanded.size === prev.expanded.size &&
        kept.length === Object.keys(prev.filesByCommit).length
      ) {
        return prev
      }
      return { ...prev, expanded, filesByCommit: Object.fromEntries(kept) }
    })
  }, [result])

  const toggleExpand = useCallback(
    (item: GitHistoryItem): void => {
      const id = item.id
      const willExpand = !expansion.expanded.has(id)
      setExpansion((prev) => {
        const expanded = new Set(prev.expanded)
        if (willExpand) {
          expanded.add(id)
        } else {
          expanded.delete(id)
        }
        return { ...prev, expanded }
      })
      if (!willExpand || !onLoadCommitFiles || isCommitFilesResolved(expansion.filesByCommit[id])) {
        return
      }
      const loadScope = expansion.worktreeId
      // Drop a completion whose worktree has since changed: the sibling commit-compare cache is
      // gone, so recording the files would leave rows that look loaded but cannot open.
      const applyFiles = (state: GitHistoryCommitFilesState): void => {
        setExpansion((prev) =>
          prev.worktreeId !== loadScope
            ? prev
            : { ...prev, filesByCommit: { ...prev.filesByCommit, [id]: state } }
        )
      }
      applyFiles({ status: 'loading' })
      onLoadCommitFiles(item)
        .then((entries) => {
          applyFiles({ status: 'ready', entries })
        })
        .catch((error: unknown) => {
          applyFiles({
            status: 'error',
            error:
              error instanceof Error
                ? error.message
                : translate(
                    'auto.components.right.sidebar.GitHistoryPanel.6d1e0a7c3b',
                    'Failed to load commit files'
                  )
          })
        })
    },
    [expansion, onLoadCommitFiles]
  )

  return { expanded: expansion.expanded, filesByCommit: expansion.filesByCommit, toggleExpand }
}
