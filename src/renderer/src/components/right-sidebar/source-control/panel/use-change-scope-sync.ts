import { useEffect } from 'react'
import { translate } from '@/i18n/i18n'
import type { GitHistoryItem } from '../../../../../../shared/git/history/git-history-types'
import type { GitBranchChangeEntry } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitHistoryPanelState } from '../sync/use-git-history'
import {
  ALL_CHANGES_SCOPE,
  provesPickedCommitGone,
  type SourceControlChangeScope,
  type SourceControlCommitScopeFiles
} from './change-scope'

/** Load a picked commit's files, and fall back to All changes once a fenced, complete page proves it left the branch. */
export function useChangeScopeSync({
  changeScope,
  setChangeScope,
  setCommitScopeFiles,
  gitHistoryState,
  statusHead,
  loadCommitFiles
}: {
  changeScope: SourceControlChangeScope
  setChangeScope: (scope: SourceControlChangeScope) => void
  setCommitScopeFiles: (files: SourceControlCommitScopeFiles | null) => void
  gitHistoryState: GitHistoryPanelState
  statusHead: string | null
  loadCommitFiles: (item: GitHistoryItem) => Promise<GitBranchChangeEntry[]>
}): void {
  const commitScope = changeScope.kind === 'commit' ? changeScope : null
  const commit = commitScope?.commit ?? null

  useEffect(() => {
    if (!commit) {
      setCommitScopeFiles(null)
      return
    }
    let live = true
    setCommitScopeFiles({ commitId: commit.id, status: 'loading' })
    loadCommitFiles(commit)
      .then((entries) => {
        if (live) {
          setCommitScopeFiles({ commitId: commit.id, status: 'ready', entries })
        }
      })
      .catch((error: unknown) => {
        if (live) {
          setCommitScopeFiles({
            commitId: commit.id,
            status: 'error',
            error:
              error instanceof Error
                ? error.message
                : translate(
                    'auto.components.right.sidebar.GitHistoryPanel.6d1e0a7c3b',
                    'Failed to load commit files'
                  )
          })
        }
      })
    return () => {
      live = false
    }
  }, [commit, loadCommitFiles, setCommitScopeFiles])

  const result = gitHistoryState.status === 'ready' ? gitHistoryState.result : undefined
  useEffect(() => {
    if (commitScope && result && provesPickedCommitGone(commitScope, result, statusHead)) {
      setChangeScope(ALL_CHANGES_SCOPE)
    }
  }, [commitScope, result, setChangeScope, statusHead])
}
