import { transitionTaskPageGitHubMutationQuery } from '@/components/task-page/github/task-page-github-work-item-mutation-pages'

import { shouldSkipLocalViewerQualifiers } from '@/lib/task-repo-source-context'

export { shouldSkipLocalViewerQualifiers } from '@/lib/task-repo-source-context'
import type { Repo } from '../../../shared/repo-types'

import { createTaskPageGitHubAuthorityProjection } from '@/components/task-page/github/task-page-github-work-item-mutation-composition'

import {
  captureGitHubTaskObservation,
  createGitHubTaskObservationIndex,
  type GitHubTaskObservation
} from '@/lib/github-task-observation'

import { getTaskPageRepoSourceContext } from '@/components/task-page/task-page-source-context'

import { githubWorkItemWriteKey, withGitHubWorkItemWrite } from '@/lib/github-work-item-writes'

import { useCallback, useEffect, useRef, useState, useMemo } from 'react'

import { toast } from 'sonner'

import type { ParsedTaskQuery } from '../../../shared/task-query'

import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

import type { TaskSourceContext } from '../../../shared/task-source-context'

import { useAppStore } from '@/store'

import {
  beginTaskPageGitHubWorkItemMutation,
  canStartTaskPageGitHubWorkItemMutation
} from '@/components/task-page/github/task-page-github-work-item-mutations'

import {
  confirmTaskPageGitHubWorkItemMutation,
  rollbackTaskPageGitHubWorkItemMutation
} from '@/components/task-page/github/task-page-github-work-item-mutation-lifecycle'

import type { TaskPageGitHubMutationIntent } from '@/components/task-page/github/task-page-github-work-item-mutation-patches'

import type {
  CurrentListInputResolver,
  TaskPageGitHubPatchWorkItem
} from '@/components/task-page/github/task-page-github-work-item-mutation-types'

import {
  subscribeTaskPageGitHubMutationRegistry,
  getTaskPageGitHubMutationSnapshot
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import { useMountedRef } from './useMountedRef'
import { codeHostErrorText } from '@/lib/code-host-error-copy'

export type UseTaskPageGitHubWorkItemMutationArgs = {
  repos?: readonly Repo[]
  queryKey: string
  query: ParsedTaskQuery
  viewerLogin: string | null
  patchWorkItem: TaskPageGitHubPatchWorkItem
  resolveCurrentListInput?: CurrentListInputResolver
  transitionQuery?: (queryKey: string) => void
}

export function useTaskPageGitHubWorkItemMutation(args: UseTaskPageGitHubWorkItemMutationArgs): {
  run: (input: {
    item: GitHubWorkItem
    intent: TaskPageGitHubMutationIntent
    sourceContext?: TaskSourceContext | null
    mutate: () => Promise<{ ok?: boolean; error?: string | { message?: string } } | void>
    successToast?: string
    errorToast: string
  }) => Promise<'confirmed' | 'rolled_back' | 'stale'>
  isIntentPending: (input: {
    item: GitHubWorkItem
    intent: TaskPageGitHubMutationIntent
    sourceContext?: TaskSourceContext | null
  }) => boolean
  registryVersion: number
} {
  const patchWorkItem = args.patchWorkItem
  const resolveCurrentListInput = args.resolveCurrentListInput
  const suppliedTransition = args.transitionQuery
  const transitionQuery = useCallback(
    (queryKey: string) => {
      if (suppliedTransition) {
        suppliedTransition(queryKey)
      } else {
        transitionTaskPageGitHubMutationQuery(queryKey, useAppStore.getState())
      }
    },
    [suppliedTransition]
  )
  const repos = useAppStore.getState().repos ?? []
  const observationForItem = createGitHubTaskObservationIndex(repos, (repo) =>
    getTaskPageRepoSourceContext(repo, 'github')
  )
  const activeRepos = args.repos ?? repos
  const currentObservationForItem = createGitHubTaskObservationIndex(activeRepos, (repo) =>
    getTaskPageRepoSourceContext(repo, 'github')
  )
  const owners = activeRepos.flatMap((repo) => {
    const owner = captureGitHubTaskObservation(repo, getTaskPageRepoSourceContext(repo, 'github'))
    return owner ? [owner] : []
  })
  const mountedRef = useMountedRef()
  const activeQueryRef = useRef({
    query: args.query,
    queryKey: args.queryKey,
    viewerLogin: args.viewerLogin,
    observationForItem: currentObservationForItem,
    owners
  })
  activeQueryRef.current = {
    query: args.query,
    queryKey: args.queryKey,
    viewerLogin: args.viewerLogin,
    observationForItem: currentObservationForItem,
    owners
  }
  const [registryVersion, setRegistryVersion] = useState(0)
  useEffect(() => {
    transitionQuery(args.queryKey)
  }, [args.queryKey, transitionQuery])
  const snapshotRef = useRef<readonly unknown[]>([])
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  snapshotRef.current = getTaskPageGitHubMutationSnapshot(owners)
  useEffect(
    () =>
      subscribeTaskPageGitHubMutationRegistry(() => {
        const next = getTaskPageGitHubMutationSnapshot(activeQueryRef.current.owners)
        if (
          next.length !== snapshotRef.current.length ||
          next.some((entry, index) => entry !== snapshotRef.current[index])
        ) {
          snapshotRef.current = next
          setRegistryVersion((value) => value + 1)
        }
      }),
    []
  )

  const projection = useMemo(() => createTaskPageGitHubAuthorityProjection(), [registryVersion])
  const isIntentPending = useCallback(
    (input: {
      item: GitHubWorkItem
      intent: TaskPageGitHubMutationIntent
      sourceContext?: TaskSourceContext | null
    }) =>
      !canStartTaskPageGitHubWorkItemMutation({
        ...input,
        observation: observationForItem(input.item, input.sourceContext),
        projection
      }),
    [observationForItem, projection]
  )

  const { query, queryKey, viewerLogin } = args

  const execute = useCallback(
    async (input: {
      observation?: GitHubTaskObservation
      item: GitHubWorkItem
      intent: TaskPageGitHubMutationIntent
      sourceContext?: TaskSourceContext | null
      mutate: () => Promise<{
        ok?: boolean
        error?: string | { message?: string }
        errorCode?: unknown
        errorDetail?: unknown
      } | void>
      successToast?: string
      errorToast: string
    }): Promise<'confirmed' | 'rolled_back' | 'stale'> => {
      const skipMeQualifiers = shouldSkipLocalViewerQualifiers(input.sourceContext)
      const began = beginTaskPageGitHubWorkItemMutation({
        item: input.item,
        observation: input.observation,
        intent: input.intent,
        sourceContext: input.sourceContext,
        query,
        queryKey,
        viewerLogin,
        skipMeQualifiers,
        patchWorkItem,
        resolveCurrentListInput,
        transitionQuery
      })

      try {
        const result = await input.mutate()
        const activeQuery = activeQueryRef.current
        const typed = result
        if (typed && typeof typed === 'object' && typed.ok === false) {
          const rolled = rollbackTaskPageGitHubWorkItemMutation({
            key: began.key,
            generation: began.generation,
            patchWorkItem,
            resolveCurrentListInput,
            sourceContext: input.sourceContext,
            query: activeQuery.query,
            queryKey: activeQuery.queryKey,
            viewerLogin: activeQuery.viewerLogin,
            item: input.item,
            currentObservation: activeQuery.observationForItem(input.item)
          })
          if (rolled === 'rolled_back' && mountedRef.current) {
            const message =
              typeof typed.error === 'string'
                ? codeHostErrorText({ ...typed, error: typed.error })
                : (typed.error?.message ?? input.errorToast)
            toast.error(message)
          }
          return rolled
        }

        const confirmed = confirmTaskPageGitHubWorkItemMutation(began.key, began.generation, {
          query: activeQuery.query,
          queryKey: activeQuery.queryKey,
          viewerLogin: activeQuery.viewerLogin,
          item: input.item,
          currentObservation: activeQuery.observationForItem(input.item),
          patchWorkItem,
          resolveCurrentListInput,
          sourceContext: input.sourceContext,
          // The separately registered TaskPage runner performs the revalidation.
          scheduleQuiet: false
        })
        if (confirmed === 'confirmed') {
          if (input.successToast && mountedRef.current) {
            toast.success(input.successToast)
          }
          useAppStore.getState().recordFeatureInteraction('github-tasks')
        }
        return confirmed
      } catch (err) {
        const activeQuery = activeQueryRef.current
        const rolled = rollbackTaskPageGitHubWorkItemMutation({
          key: began.key,
          generation: began.generation,
          patchWorkItem,
          resolveCurrentListInput,
          sourceContext: input.sourceContext,
          query: activeQuery.query,
          queryKey: activeQuery.queryKey,
          viewerLogin: activeQuery.viewerLogin,
          item: input.item,
          currentObservation: activeQuery.observationForItem(input.item)
        })
        if (rolled === 'rolled_back' && mountedRef.current) {
          toast.error(err instanceof Error ? err.message : input.errorToast)
        }
        return rolled
      }
    },
    [
      query,
      queryKey,
      viewerLogin,
      mountedRef,
      patchWorkItem,
      resolveCurrentListInput,
      transitionQuery
    ]
  )

  const run = useCallback(
    (input: Parameters<typeof execute>[0]) => {
      const captured = {
        ...input,
        observation: observationForItem(input.item, input.sourceContext)
      }
      if (!canStartTaskPageGitHubWorkItemMutation(captured)) {
        return Promise.resolve('stale' as const)
      }
      return input.item.type === 'issue'
        ? withGitHubWorkItemWrite(githubWorkItemWriteKey(input.item, input.sourceContext), () =>
            execute(captured)
          )
        : execute(captured)
    },
    [execute, observationForItem]
  )
  return { run, isIntentPending, registryVersion }
}
