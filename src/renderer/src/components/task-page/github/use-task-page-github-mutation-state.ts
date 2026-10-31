import type { TaskPageGitHubMutationStateInput } from './task-page-github-delivery-inputs'
import { dependsOnTaskPageGitHubListRetirement } from './task-page-github-work-item-mutation-composition'

import { transitionTaskPageGitHubMutationQuery } from './task-page-github-work-item-mutation-pages'

import { prepareWorkItemPatches } from '@/store/github/work-item-cache-patches'

import {
  listInput,
  setTaskPageGitHubMembershipActivation,
  getTaskPageGitHubConfirmedAuthorities
} from './task-page-github-work-item-mutation-registry'

import type {
  CurrentListInputResolver,
  TaskPageGitHubPatchWorkItem
} from './task-page-github-work-item-mutation-types'

import { parseGitHubIssueOrPRLink, buildGitHubRepoUrl } from '../../../../../shared/github/links'

import { githubRepoIdentityKey } from '../../../../../shared/github/repository-identity-key'

import { getRepoExecutionHostId } from '../../../../../shared/execution-host'

import { getGitHubRepoLookupIndex } from '@/store/slices/github-repo-lookup-index'

import {
  captureGitHubTaskObservation,
  getGitHubTaskObservation,
  createGitHubTaskObservationIndex
} from '@/lib/github-task-observation'

import type { TaskPageLinearCreationStateModel } from '../linear/use-task-page-linear-creation-state'

import { getGitHubTaskKind } from '../../../../../shared/task-github-search'

import { useMemo, useLayoutEffect, useEffect, useCallback, useRef } from 'react'

import { parseTaskQuery } from '../../../../../shared/task-query'

import { getOrCreateQuietRevalidateState } from '@/components/task-page/github/task-page-github-work-item-quiet-state'

import { useAppStore } from '@/store/index'

import { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'

import { getTaskPageRepoSourceContext } from '../task-page-source-context'

export function useTaskPageGitHubMutationState<T extends TaskPageGitHubMutationStateInput>(
  model: T
) {
  const {
    pagesRef,
    setPages,
    selectedRepos,
    taskSource,
    githubMode,
    appliedTaskSearch,
    activeTaskPreset,
    setQuietRefreshNonce,
    githubViewerLogin,
    setGitHubViewerLogin,
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
      const ownerKey = options?.ownerRepo ? githubRepoIdentityKey(options.ownerRepo) : undefined
      const registered = getGitHubRepoLookupIndex(useAppStore.getState().repos)
      useAppStore.getState().patchWorkItem(id, patch, repoId, options)
      const currentOwner =
        options?.observation &&
        createGitHubTaskObservationIndex(
          useAppStore.getState().repos,
          () => options.sourceContext ?? null
        )(
          { repoId: options.observation.repoId, repoHostId: options.observation.hostId },
          options.sourceContext
        )
      if (
        repoId &&
        (!options?.observation ||
          currentOwner?.key === options.observation.key ||
          (!Object.keys(patch).length &&
            options.listComposition?.length &&
            options.listComposition.every((plan) => plan.retirement)))
      ) {
        patchTaskPageWorkItemRows(
          {
            id,
            repoId
          },
          options?.valueOrigins ? { ...patch, githubValueOrigins: options.valueOrigins } : patch,
          (item) => {
            const repository = ownerKey ? parseGitHubIssueOrPRLink(item.url)?.slug : undefined
            const legacyRepo =
              !item.repoHostId && !getGitHubTaskObservation(item)
                ? registered.findForWorkItem(item)
                : undefined
            const hostId =
              item.repoHostId ??
              getGitHubTaskObservation(item)?.hostId ??
              (legacyRepo && getRepoExecutionHostId(legacyRepo))
            return (
              item.id === id &&
              (!options?.observation ||
                currentOwner?.key === options.observation.key ||
                !!options.listComposition?.some(
                  (plan) =>
                    plan.retirement && dependsOnTaskPageGitHubListRetirement(item, plan.retirement)
                )) &&
              (!options?.observation || hostId === options.observation.hostId) &&
              (!ownerKey || (!!repository && githubRepoIdentityKey(repository) === ownerKey))
            )
          },
          options?.listComposition
        )
      }
    },
    [patchTaskPageWorkItemRows]
  )
  const resolveCurrentListInput = useCallback<CurrentListInputResolver>(
    (address, clickedRow) => {
      const state = useAppStore.getState()
      const current =
        address.observation &&
        createGitHubTaskObservationIndex(state.repos, () => address.observation?.source ?? null)(
          { repoId: address.repoId, repoHostId: address.observation.hostId },
          address.observation.source
        )
      if (address.observation && current?.key !== address.observation.key) {
        return listInput(clickedRow, address.family, address.observation)
      }
      const ownerRepo =
        clickedRow.type === 'issue' ? parseGitHubIssueOrPRLink(clickedRow.url)?.slug : undefined
      const ownerKey = ownerRepo && githubRepoIdentityKey(ownerRepo)
      for (const row of pagesRef?.current.flatMap((page) => page ?? []) ?? []) {
        const repository = parseGitHubIssueOrPRLink(row.url)?.slug
        if (
          row.repoId !== address.repoId ||
          row.id !== clickedRow.id ||
          (ownerKey && (repository && githubRepoIdentityKey(repository)) !== ownerKey)
        ) {
          continue
        }
        const input = listInput(row, address.family, address.observation)
        if (input.kind === 'full') {
          return input
        }
      }
      const prepared = prepareWorkItemPatches(
        state,
        [
          {
            itemId: clickedRow.id,
            repoId: address.repoId,
            patch: {},
            options: {
              sourceContext: address.observation?.source,
              observation: address.observation,
              ownerRepo,
              listComposition: [{ address }]
            }
          }
        ],
        false
      )
      return (
        prepared.existingEntryBaseObservations[0]?.input ??
        listInput(clickedRow, address.family, address.observation)
      )
    },
    [pagesRef]
  )
  const transitionQuery = useCallback(
    (queryKey: string) => {
      transitionTaskPageGitHubMutationQuery(
        queryKey,
        useAppStore.getState(),
        pagesRef?.current,
        setPages
      )
    },
    [pagesRef, setPages]
  )
  useLayoutEffect(
    () => transitionQuery(githubWorkItemMutationQueryKey),
    [githubWorkItemMutationQueryKey, transitionQuery]
  )
  const githubWorkItemMutation = useTaskPageGitHubWorkItemMutation({
    repos: selectedRepos,
    queryKey: githubWorkItemMutationQueryKey,
    query: appliedTaskQuery,
    viewerLogin: githubViewerLogin,
    patchWorkItem: patchCoordinatedGitHubWorkItem,
    resolveCurrentListInput,
    transitionQuery
  })
  const membershipActivation = JSON.stringify(
    selectedRepos
      .map(
        (repo) =>
          captureGitHubTaskObservation(repo, getTaskPageRepoSourceContext(repo, 'github'))?.key
      )
      .sort()
  )
  useLayoutEffect(() => {
    setTaskPageGitHubMembershipActivation(membershipActivation)
  }, [githubWorkItemMutationQueryKey, membershipActivation])
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
    if (getTaskPageGitHubConfirmedAuthorities().length > 0 && (enteringScope || dirtyAdvanced)) {
      scheduleQuietRevalidate()
    }
  }, [
    githubMode,
    githubWorkItemMutation.registryVersion,
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
export type TaskPageGitHubMutationStateModel = ReturnType<
  typeof useTaskPageGitHubMutationState<TaskPageLinearCreationStateModel>
>
