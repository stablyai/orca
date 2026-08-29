import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { ParsedTaskQuery } from '../../../shared/task-query'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { useAppStore } from '@/store'
import {
  beginTaskPageGitHubWorkItemMutation,
  canStartTaskPageGitHubWorkItemMutation,
  confirmTaskPageGitHubWorkItemMutation,
  rollbackTaskPageGitHubWorkItemMutation
} from '@/components/task-page-github-work-item-mutations'
import type { TaskPageGitHubMutationIntent } from '@/components/task-page-github-work-item-mutation-patches'
import type { TaskPageGitHubPatchWorkItem } from '@/components/task-page-github-work-item-mutation-types'
import {
  getTaskPageGitHubSoftHiddenItemKeys,
  subscribeTaskPageGitHubMutationRegistry,
  setTaskPageGitHubMutationQueryKey
} from '@/components/task-page-github-work-item-mutation-registry'
import { useMountedRef } from './useMountedRef'

export type UseTaskPageGitHubWorkItemMutationArgs = {
  queryKey: string
  query: ParsedTaskQuery
  /** Local gh viewer login only; may be null. */
  viewerLogin: string | null
  patchWorkItem: TaskPageGitHubPatchWorkItem
}

export function shouldSkipLocalViewerQualifiers(sourceContext?: TaskSourceContext | null): boolean {
  if (!sourceContext) {
    return false
  }
  // Why: local gh viewer must not evaluate @me soft-hide for SSH/environment rows.
  const hostKind = parseExecutionHostId(sourceContext.hostId)?.kind
  if (hostKind === 'ssh' || hostKind === 'runtime') {
    return true
  }
  const providerHost =
    sourceContext.providerIdentity?.provider === 'github'
      ? sourceContext.providerIdentity.host?.toLowerCase()
      : undefined
  return Boolean(providerHost && providerHost !== 'github.com')
}

export function useTaskPageGitHubWorkItemMutation(args: UseTaskPageGitHubWorkItemMutationArgs): {
  run: (input: {
    item: GitHubWorkItem
    intent: TaskPageGitHubMutationIntent
    sourceContext?: TaskSourceContext | null
    mutate: () => Promise<{ ok?: boolean; error?: string | { message?: string } } | void>
    successToast?: string
    errorToast: string
    serverEntityFromResult?: (result: unknown) => Partial<GitHubWorkItem> | undefined
  }) => Promise<'confirmed' | 'rolled_back' | 'stale'>
  isIntentPending: (input: {
    item: GitHubWorkItem
    intent: TaskPageGitHubMutationIntent
    sourceContext?: TaskSourceContext | null
  }) => boolean
  softHiddenItemKeys: ReadonlySet<string>
} {
  const patchWorkItem = args.patchWorkItem
  const mountedRef = useMountedRef()
  const activeQueryRef = useRef({
    query: args.query,
    queryKey: args.queryKey,
    viewerLogin: args.viewerLogin
  })
  activeQueryRef.current = {
    query: args.query,
    queryKey: args.queryKey,
    viewerLogin: args.viewerLogin
  }
  const [softHiddenItemKeys, setSoftHiddenItemKeys] = useState<ReadonlySet<string>>(
    () => new Set(getTaskPageGitHubSoftHiddenItemKeys())
  )

  useEffect(() => {
    setTaskPageGitHubMutationQueryKey(args.queryKey)
  }, [args.queryKey])

  useEffect(() => {
    setSoftHiddenItemKeys(new Set(getTaskPageGitHubSoftHiddenItemKeys()))
    return subscribeTaskPageGitHubMutationRegistry(() => {
      setSoftHiddenItemKeys(new Set(getTaskPageGitHubSoftHiddenItemKeys()))
    })
  }, [])

  const isIntentPending = useCallback(
    (input: {
      item: GitHubWorkItem
      intent: TaskPageGitHubMutationIntent
      sourceContext?: TaskSourceContext | null
    }) => !canStartTaskPageGitHubWorkItemMutation(input),
    []
  )

  const { query, queryKey, viewerLogin } = args

  const run = useCallback(
    async (input: {
      item: GitHubWorkItem
      intent: TaskPageGitHubMutationIntent
      sourceContext?: TaskSourceContext | null
      mutate: () => Promise<{ ok?: boolean; error?: string | { message?: string } } | void>
      successToast?: string
      errorToast: string
      serverEntityFromResult?: (result: unknown) => Partial<GitHubWorkItem> | undefined
    }): Promise<'confirmed' | 'rolled_back' | 'stale'> => {
      if (!canStartTaskPageGitHubWorkItemMutation(input)) {
        return 'stale'
      }
      const skipMeQualifiers = shouldSkipLocalViewerQualifiers(input.sourceContext)
      const began = beginTaskPageGitHubWorkItemMutation({
        item: input.item,
        intent: input.intent,
        sourceContext: input.sourceContext,
        query,
        queryKey,
        viewerLogin,
        skipMeQualifiers,
        patchWorkItem
      })

      try {
        const result = await input.mutate()
        const activeQuery = activeQueryRef.current
        const typed = result as { ok?: boolean; error?: string | { message?: string } } | void
        if (typed && typeof typed === 'object' && typed.ok === false) {
          const rolled = rollbackTaskPageGitHubWorkItemMutation({
            key: began.key,
            generation: began.generation,
            patchWorkItem,
            sourceContext: input.sourceContext,
            query: activeQuery.query,
            queryKey: activeQuery.queryKey,
            viewerLogin: activeQuery.viewerLogin,
            item: input.item
          })
          if (rolled === 'rolled_back' && mountedRef.current) {
            const message =
              typeof typed.error === 'string'
                ? typed.error
                : (typed.error?.message ?? input.errorToast)
            toast.error(message)
          }
          return rolled
        }

        const serverEntity = input.serverEntityFromResult?.(result)
        const confirmed = confirmTaskPageGitHubWorkItemMutation(began.key, began.generation, {
          query: activeQuery.query,
          queryKey: activeQuery.queryKey,
          viewerLogin: activeQuery.viewerLogin,
          item: input.item,
          serverEntity,
          patchWorkItem,
          sourceContext: input.sourceContext,
          // Quiet revalidate: mark dirty; TaskPage runner is registered separately.
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
          sourceContext: input.sourceContext,
          query: activeQuery.query,
          queryKey: activeQuery.queryKey,
          viewerLogin: activeQuery.viewerLogin,
          item: input.item
        })
        if (rolled === 'rolled_back' && mountedRef.current) {
          toast.error(err instanceof Error ? err.message : input.errorToast)
        }
        return rolled
      }
    },
    [query, queryKey, viewerLogin, mountedRef, patchWorkItem]
  )

  return { run, isIntentPending, softHiddenItemKeys }
}
