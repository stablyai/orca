import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'

import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { stripRepoQualifiers } from '../../../../../shared/task-query'
import {
  buildTaskPageRepoSourceState,
  reconcileTaskPagePagesWithWorkItemsCache,
  selectTaskPageUnresolvedSourceRepos,
  selectTaskPageWorkItemsCacheEntries,
  type TaskPageRepoSourceState
} from '@/components/task-page-cache-selectors'
import { overlayPendingOnTaskPagePages } from '@/components/task-page-github-work-item-mutations'
import { getTaskPageRepoCacheInput } from '@/components/task-page/source/repo-source-context'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { TaskProvider } from '../../../../../shared/task-providers'

export function useTaskPageGitHubSourceBanners({
  selectedRepos,
  appliedTaskSearch,
  githubPerRepoPageLimit,
  taskSource,
  githubMode,
  setPages,
  setTaskRefreshNonce,
  setTasksRefreshing
}: {
  selectedRepos: readonly Repo[]
  appliedTaskSearch: string
  githubPerRepoPageLimit: number
  taskSource: TaskProvider
  githubMode: 'items' | 'project'
  setPages: Dispatch<SetStateAction<(GitHubWorkItem[] | null)[]>>
  setTaskRefreshNonce: Dispatch<SetStateAction<number>>
  setTasksRefreshing: Dispatch<SetStateAction<boolean>>
}) {
  const appliedWorkItemsCacheQuery = useMemo(
    () => stripRepoQualifiers(appliedTaskSearch.trim()),
    [appliedTaskSearch]
  )
  const selectedWorkItemsCacheEntries = useAppStore(
    useShallow((s) =>
      selectTaskPageWorkItemsCacheEntries(
        s.workItemsCache,
        selectedRepos.map(getTaskPageRepoCacheInput),
        githubPerRepoPageLimit,
        appliedWorkItemsCacheQuery
      )
    )
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
      reconcileTaskPagePagesWithWorkItemsCache(current, selectedWorkItemsCacheEntries).map((page) =>
        page ? (overlayPendingOnTaskPagePages([page])[0] ?? []) : null
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
          { value0: prSlug }
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
  }, [setTaskRefreshNonce, setTasksRefreshing])

  return {
    selectedWorkItemsCacheEntries,
    perRepoSourceState,
    unresolvedSourceRepos,
    retryingSourceKeys,
    setRetryingSourceKeys,
    handleRetryIssuesFetch,
    handleRefreshGithubTasks
  }
}
