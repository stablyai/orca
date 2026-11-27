import { useEffect, useReducer, useRef } from 'react'
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

/** Load a picked commit's files, follow its parents on a fenced page, and fall back to All changes once a complete page proves it left the branch. */
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
}): (onLoaded: () => void) => void {
  const commitScope = changeScope.kind === 'commit' ? changeScope : null
  const commit = commitScope?.commit ?? null
  const [commitFilesAttempt, requestRetry] = useReducer((attempt: number) => attempt + 1, 0)
  const retryRequest = useRef<{
    commit: GitHistoryItem
    loader: typeof loadCommitFiles
    onLoaded: () => void
  } | null>(null)
  // Why: a second Retry before the busy row renders would restart the load and drop a read that was about to succeed.
  const retryInFlight = useRef(false)

  useEffect(() => {
    const retry = retryRequest.current
    retryRequest.current = null
    if (!commit) {
      retryInFlight.current = false
      setCommitScopeFiles(null)
      return
    }
    const onLoaded =
      retry?.commit === commit && retry.loader === loadCommitFiles ? retry.onLoaded : undefined
    retryInFlight.current = onLoaded !== undefined
    let live = true
    setCommitScopeFiles({ commitId: commit.id, status: onLoaded ? 'retrying' : 'loading' })
    loadCommitFiles(commit)
      .then((entries) => {
        if (live) {
          retryInFlight.current = false
          onLoaded?.()
          setCommitScopeFiles({ commitId: commit.id, status: 'ready', entries })
        }
      })
      .catch((error: unknown) => {
        if (live) {
          retryInFlight.current = false
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
  }, [commit, commitFilesAttempt, loadCommitFiles, setCommitScopeFiles])

  const result = gitHistoryState.status === 'ready' ? gitHistoryState.result : undefined
  useEffect(() => {
    if (!commitScope || !result) {
      return
    }
    if (provesPickedCommitGone(commitScope, result, statusHead)) {
      setChangeScope(ALL_CHANGES_SCOPE)
      return
    }
    // A deepened shallow clone shows the picked commit's parent; follow the page so its compare reads again.
    const shown = result.items.find((item) => item.id === commitScope.commit.id)
    if (shown && shown.parentIds.join() !== commitScope.commit.parentIds.join()) {
      setChangeScope({ ...commitScope, commit: shown })
    }
  }, [commitScope, result, setChangeScope, statusHead])

  return (onLoaded) => {
    if (commit && !retryInFlight.current) {
      retryInFlight.current = true
      retryRequest.current = { commit, loader: loadCommitFiles, onLoaded }
      requestRetry()
    }
  }
}
