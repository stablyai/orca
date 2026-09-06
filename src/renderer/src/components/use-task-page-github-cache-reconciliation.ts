import type { TaskPageGitHubDetailModel } from './use-task-page-github-detail'
import { useCallback, useMemo, useEffect, useRef, useState } from 'react'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { GitHubAssignableUser } from '../../../shared/github/pull-request-types'
import {
  patchTaskPageGitHubWorkItemPages,
  overlayPendingOnTaskPagePages
} from '@/components/task-page-github-work-item-mutations'
import {
  type TaskPageRepoSourceState,
  buildTaskPageRepoSourceState,
  selectTaskPageUnresolvedSourceRepos,
  reconcileTaskPagePagesWithWorkItemsCache
} from '@/components/task-page-cache-selectors'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
export function useTaskPageGitHubCacheReconciliation(model: TaskPageGitHubDetailModel) {
  const {
    selectedRepos,
    taskSource,
    githubMode,
    setTasksRefreshing,
    setTaskRefreshNonce,
    setPages,
    selectedWorkItemsCacheEntries
  } = model
  const patchTaskPageWorkItemRows = useCallback(
    (
      itemKey: {
        id: string
        repoId: string
      },
      patch: Partial<GitHubWorkItem>,
      shouldPatch?: (item: GitHubWorkItem) => boolean
    ): void => {
      setPages((current) => {
        return patchTaskPageGitHubWorkItemPages(current, itemKey, patch, shouldPatch)
      })
    },
    [setPages]
  )
  const handleDialogReviewRequestsChange = useCallback(
    (
      itemKey: {
        id: string
        repoId: string
      },
      reviewRequests: GitHubAssignableUser[]
    ): void => {
      patchTaskPageWorkItemRows(itemKey, {
        reviewRequests
      })
    },
    [patchTaskPageWorkItemRows]
  )

  // Why: the per-repo issue-source indicator and retry banner both derive from the same workItemsCache entry, so no extra IPC.
  // Why: subscribe only to entries this page renders; the selector returns entry refs so shallow equality filters unrelated cache writes.
  const perRepoSourceState = useMemo<TaskPageRepoSourceState[]>(
    () => buildTaskPageRepoSourceState(selectedRepos, selectedWorkItemsCacheEntries),
    [selectedRepos, selectedWorkItemsCacheEntries]
  )

  // Why: repos that fetched but resolved no GitHub source (#9660) show empty like a genuine zero-result; surface them explicitly with Retry.
  const unresolvedSourceRepos = useMemo(
    () => selectTaskPageUnresolvedSourceRepos(selectedRepos, perRepoSourceState),
    [selectedRepos, perRepoSourceState]
  )
  useEffect(() => {
    if (taskSource !== 'github' || githubMode !== 'items') {
      return
    }
    // Why: inline/dialog edits patch `workItemsCache`; the paged table renders
    // from a local snapshot so it needs the patched row objects copied across.
    // Hard guarantee (K4): always overlay pending after reconcile so list
    // fetch clobbers never paint unprotected coordinator fields.
    setPages((current) =>
      reconcileTaskPagePagesWithWorkItemsCache(current, selectedWorkItemsCacheEntries).map(
        (page) => (page ? (overlayPendingOnTaskPagePages([page])[0] ?? []) : null)
      )
    )
  }, [githubMode, selectedWorkItemsCacheEntries, taskSource, setPages])

  // Why: one-time toast per repo when the 'upstream' preference fell back to origin (ref-gated); deliberately don't auto-reset the preference so re-adding upstream later still applies.
  const fellBackToastedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (taskSource !== 'github') {
      return
    }
    for (const [index, r] of selectedRepos.entries()) {
      const entry = selectedWorkItemsCacheEntries[index]
      if (!entry?.issueSourceFellBack) {
        continue
      }
      if (fellBackToastedRef.current.has(r.id)) {
        continue
      }
      const prSlug = entry.sources?.prs
        ? `${entry.sources.prs.owner}/${entry.sources.prs.repo}`
        : r.displayName
      toast.message(
        translate(
          'auto.components.TaskPage.f4374519ae',
          'Your preferred issue source (upstream) is no longer configured for {{value0}}. Using origin.',
          {
            value0: prSlug
          }
        )
      )
      fellBackToastedRef.current.add(r.id)
    }
  }, [selectedRepos, selectedWorkItemsCacheEntries, taskSource])

  // Why: partial-failure retry leaves the cache populated so tasksLoading never flips, giving no feedback; track retry-in-flight per source so only the clicked banner shows "Retrying…".
  const [retryingSourceKeys, setRetryingSourceKeys] = useState<ReadonlySet<string>>(() => new Set())
  const handleRetryIssuesFetch = useCallback(
    (sourceKey: string) => {
      const source = perRepoSourceState.find((s) => s.sourceKey === sourceKey)
      if (!source) {
        return
      }
      // Why: nonce bump reuses the fetch path as force=true so retry doesn't dedupe onto a still-failing in-flight request (refreshes all repos; Retrying… stays scoped to the clicked source).
      setRetryingSourceKeys((prev) => {
        const next = new Set(prev)
        next.add(source.sourceKey)
        return next
      })
      setTaskRefreshNonce((n) => n + 1)
    },
    [perRepoSourceState, setTaskRefreshNonce]
  )
  const handleRefreshGithubTasks = useCallback((): void => {
    setTasksRefreshing(true)
    setTaskRefreshNonce((current) => current + 1)
  }, [setTasksRefreshing, setTaskRefreshNonce])
  const nextModel = model as typeof model & {
    patchTaskPageWorkItemRows: typeof patchTaskPageWorkItemRows
    handleDialogReviewRequestsChange: typeof handleDialogReviewRequestsChange
    perRepoSourceState: typeof perRepoSourceState
    unresolvedSourceRepos: typeof unresolvedSourceRepos
    fellBackToastedRef: typeof fellBackToastedRef
    retryingSourceKeys: typeof retryingSourceKeys
    setRetryingSourceKeys: typeof setRetryingSourceKeys
    handleRetryIssuesFetch: typeof handleRetryIssuesFetch
    handleRefreshGithubTasks: typeof handleRefreshGithubTasks
  }
  nextModel.patchTaskPageWorkItemRows = patchTaskPageWorkItemRows
  nextModel.handleDialogReviewRequestsChange = handleDialogReviewRequestsChange
  nextModel.perRepoSourceState = perRepoSourceState
  nextModel.unresolvedSourceRepos = unresolvedSourceRepos
  nextModel.fellBackToastedRef = fellBackToastedRef
  nextModel.retryingSourceKeys = retryingSourceKeys
  nextModel.setRetryingSourceKeys = setRetryingSourceKeys
  nextModel.handleRetryIssuesFetch = handleRetryIssuesFetch
  nextModel.handleRefreshGithubTasks = handleRefreshGithubTasks
  return nextModel
}
export type TaskPageGitHubCacheReconciliationModel = ReturnType<
  typeof useTaskPageGitHubCacheReconciliation
>
