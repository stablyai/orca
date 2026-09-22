import type { TaskPageLinearCreationStateModel } from './use-task-page-linear-creation-state'
import { getGitHubTaskKind } from '@/components/task-page-github-task-kind'
import { useMemo, useLayoutEffect, useEffect, useCallback, useRef } from 'react'
import { parseTaskQuery } from '../../../shared/task-query'
import {
  setTaskPageGitHubMutationQueryKey,
  getOrCreateQuietRevalidateState,
  getTaskPageGitHubConfirmedAuthorityItemKeys
} from '@/components/task-page-github-work-item-mutation-registry'
import type { TaskPageGitHubPatchWorkItem } from '@/components/task-page-github-work-item-mutation-types'
import { useAppStore } from '@/store'
import { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'
import { rebuildSoftHiddenKeysFromPendingAndSticky } from '@/components/task-page-github-work-item-mutations'
import { buildGitHubRepoUrl } from '@/lib/github-links'
import { getTaskPageRepoSourceContext } from './task-page-source-context'
export function useTaskPageGitHubMutationState(model: TaskPageLinearCreationStateModel) {
  const {
    selectedRepos,
    taskSource,
    githubMode,
    appliedTaskSearch,
    activeTaskPreset,
    setQuietRefreshNonce,
    githubViewerLogin,
    setGitHubViewerLogin,
    pages,
    patchTaskPageWorkItemRows,
    perRepoSourceState
  } = model
  const activeGithubTaskKind = getGitHubTaskKind(activeTaskPreset, appliedTaskSearch)
  const appliedTaskQuery = useMemo(() => parseTaskQuery(appliedTaskSearch), [appliedTaskSearch])

  // Why: multi-repo queryKey omits a singular sourceScope (scopes include repoId).
  const githubWorkItemMutationQueryKey = useMemo(() => {
    const hostOrSetupIds = [
      ...new Set(
        selectedRepos.map((repo) => {
          const ctx = getTaskPageRepoSourceContext(repo, 'github')
          return ctx?.projectHostSetupId || ctx?.hostId || 'local'
        })
      )
    ].sort()
    const repoIds = selectedRepos.map((repo) => repo.id).sort()
    return `${githubMode}::${hostOrSetupIds.join(',')}::${repoIds.join(',')}::${appliedTaskSearch}`
  }, [appliedTaskSearch, githubMode, selectedRepos])
  useLayoutEffect(() => {
    setTaskPageGitHubMutationQueryKey(githubWorkItemMutationQueryKey)
  }, [githubWorkItemMutationQueryKey])
  useEffect(() => {
    let cancelled = false
    void window.api.gh
      .viewer()
      .then((viewer) => {
        if (!cancelled) {
          setGitHubViewerLogin(viewer?.login ?? null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitHubViewerLogin(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [setGitHubViewerLogin])
  const scheduleQuietRevalidate = useCallback(() => {
    setQuietRefreshNonce((current) => current + 1)
  }, [setQuietRefreshNonce])
  const patchCoordinatedGitHubWorkItem = useCallback(
    (...args: Parameters<TaskPageGitHubPatchWorkItem>): void => {
      const [id, patch, repoId, options] = args
      useAppStore.getState().patchWorkItem(id, patch, repoId, options)
      if (repoId) {
        patchTaskPageWorkItemRows(
          {
            id,
            repoId
          },
          patch
        )
      }
    },
    [patchTaskPageWorkItemRows]
  )
  const githubWorkItemMutation = useTaskPageGitHubWorkItemMutation({
    queryKey: githubWorkItemMutationQueryKey,
    query: appliedTaskQuery,
    viewerLogin: githubViewerLogin,
    patchWorkItem: patchCoordinatedGitHubWorkItem
  })
  useLayoutEffect(() => {
    rebuildSoftHiddenKeysFromPendingAndSticky({
      query: appliedTaskQuery,
      queryKey: githubWorkItemMutationQueryKey,
      viewerLogin: githubViewerLogin,
      items: pages.flatMap((page) => page ?? [])
    })
  }, [appliedTaskQuery, githubViewerLogin, githubWorkItemMutationQueryKey, pages])
  const observedQuietScopeRef = useRef({
    queryKey: '',
    dirtyGeneration: -1
  })
  useEffect(() => {
    if (taskSource !== 'github' || githubMode !== 'items') {
      observedQuietScopeRef.current = {
        queryKey: '',
        dirtyGeneration: -1
      }
      return
    }
    const quietState = getOrCreateQuietRevalidateState(githubWorkItemMutationQueryKey)
    const enteringScope = observedQuietScopeRef.current.queryKey !== githubWorkItemMutationQueryKey
    const dirtyAdvanced = quietState.dirtyGeneration > observedQuietScopeRef.current.dirtyGeneration
    observedQuietScopeRef.current = {
      queryKey: githubWorkItemMutationQueryKey,
      dirtyGeneration: quietState.dirtyGeneration
    }
    if (
      getTaskPageGitHubConfirmedAuthorityItemKeys().size > 0 &&
      (enteringScope || dirtyAdvanced)
    ) {
      scheduleQuietRevalidate()
    }
  }, [
    githubMode,
    githubWorkItemMutation.softHiddenItemKeys,
    githubWorkItemMutationQueryKey,
    scheduleQuietRevalidate,
    taskSource
  ])
  const selectedGitHubRepoExternalLink = useMemo(() => {
    if (selectedRepos.length !== 1) {
      return null
    }
    const [repo] = selectedRepos
    const sourceState = perRepoSourceState.find((state) => state.repoId === repo.id)
    const sources = sourceState?.sources
    const slug =
      activeGithubTaskKind === 'issues'
        ? (sources?.issues ?? sources?.prs)
        : (sources?.prs ?? sources?.issues)
    const url = buildGitHubRepoUrl(slug)
    return url
      ? {
          url,
          label: slug ? `${slug.owner}/${slug.repo}` : repo.displayName
        }
      : null
  }, [activeGithubTaskKind, perRepoSourceState, selectedRepos])
  const nextModel = model as typeof model & {
    activeGithubTaskKind: typeof activeGithubTaskKind
    appliedTaskQuery: typeof appliedTaskQuery
    githubWorkItemMutationQueryKey: typeof githubWorkItemMutationQueryKey
    scheduleQuietRevalidate: typeof scheduleQuietRevalidate
    patchCoordinatedGitHubWorkItem: typeof patchCoordinatedGitHubWorkItem
    githubWorkItemMutation: typeof githubWorkItemMutation
    observedQuietScopeRef: typeof observedQuietScopeRef
    selectedGitHubRepoExternalLink: typeof selectedGitHubRepoExternalLink
  }
  nextModel.activeGithubTaskKind = activeGithubTaskKind
  nextModel.appliedTaskQuery = appliedTaskQuery
  nextModel.githubWorkItemMutationQueryKey = githubWorkItemMutationQueryKey
  nextModel.scheduleQuietRevalidate = scheduleQuietRevalidate
  nextModel.patchCoordinatedGitHubWorkItem = patchCoordinatedGitHubWorkItem
  nextModel.githubWorkItemMutation = githubWorkItemMutation
  nextModel.observedQuietScopeRef = observedQuietScopeRef
  nextModel.selectedGitHubRepoExternalLink = selectedGitHubRepoExternalLink
  return nextModel
}
export type TaskPageGitHubMutationStateModel = ReturnType<typeof useTaskPageGitHubMutationState>
