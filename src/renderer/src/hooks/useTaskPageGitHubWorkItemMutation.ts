import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { parseExecutionHostId } from '../../../shared/execution-host'
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
import type { TaskPageGitHubPatchWorkItem } from '@/components/task-page/github/task-page-github-work-item-mutation-types'
import {
  getTaskPageGitHubSoftHiddenItemKeys,
  subscribeTaskPageGitHubMutationRegistry,
  setTaskPageGitHubMutationQueryKey
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'
import { useMountedRef } from './useMountedRef'
import { codeHostErrorText } from '@/lib/code-host-error-copy'

export type UseTaskPageGitHubWorkItemMutationArgs = {
  queryKey: string
  query: ParsedTaskQuery
  viewerLogin: string | null
  patchWorkItem: TaskPageGitHubPatchWorkItem
}

export function shouldSkipLocalViewerQualifiers(sourceContext?: TaskSourceContext | null): boolean {
  if (!sourceContext) {
    return false
  }
  // The local gh viewer cannot evaluate @me soft-hide for SSH/environment rows.
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
      mutate: () => Promise<{
        ok?: boolean
        error?: string | { message?: string }
        errorCode?: unknown
        errorDetail?: unknown
      } | void>
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
        const typed = result
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
                ? codeHostErrorText({ ...typed, error: typed.error })
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
