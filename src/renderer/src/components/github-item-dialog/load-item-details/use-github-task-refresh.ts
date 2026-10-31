import { translate } from '@/i18n/i18n'
import { getTaskPageRepoSourceContext } from '@/components/task-page/task-page-source-context'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import {
  getGitHubSourceRuntimeHost,
  canUseGitHubRepoContext
} from '@/lib/github-source-runtime-context'
import { GITHUB_CANONICAL_DETAILS_RUNTIME_CAPABILITY } from '../../../../../shared/task-source-runtime-capabilities'
import {
  githubTaskExecutionIdentity,
  captureGitHubTaskTarget,
  type GitHubTaskRefreshHandler,
  githubTaskWriteKey
} from '@/lib/github-task-target'
import { observeGitHubWorkItemWrites } from '@/lib/github-work-item-writes'
import {
  useCallback,
  useLayoutEffect,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useAppStore } from '@/store'

import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'

import {
  getWorkItemDetailsCacheKey,
  workItemDetailsCache,
  touchWorkItemDetailsCache
} from './work-item-details-cache'
import {
  startWorkItemDetailsFetch,
  loadCanonicalGitHubTaskDetails
} from './work-item-details-fetch-settle'
import { getWorkItemRepo } from '@/lib/work-item-repo-row'
import { useMountedRef } from '@/hooks/useMountedRef'

export function useGitHubTaskRefresh({
  workItem,
  repoPath,
  effectiveRepoId,
  sourceContext,
  issueRepository,
  onTaskRefresh
}: {
  workItem: GitHubWorkItem | null
  repoPath: string | null
  effectiveRepoId: string | null
  sourceContext?: TaskSourceContext | null
  issueRepository: GitHubOwnerRepo | null
  onTaskRefresh?: GitHubTaskRefreshHandler
}) {
  const registeredRepo = useAppStore((s) =>
    workItem
      ? getWorkItemRepo(s.repos, {
          ...workItem,
          repoHostId: workItem.repoHostId ?? sourceContext?.hostId
        })
      : undefined
  )
  const executionIdentity = useAppStore(() => githubTaskExecutionIdentity(registeredRepo))
  const issueSourcePreference = registeredRepo?.issueSourcePreference
  const { target } = useMemo(
    () => ({
      executionIdentity,
      target:
        workItem?.type === 'issue' && sourceContext && registeredRepo
          ? captureGitHubTaskTarget(
              useAppStore.getState,
              workItem,
              sourceContext,
              getTaskPageRepoSourceContext(registeredRepo, 'github')
            )
          : null
    }),
    [workItem, sourceContext, registeredRepo, executionIdentity]
  )
  const cache = useAppStore((s) => s.githubTaskCache)
  const binding = useMemo(
    () => (target ? cache.capture(target.repo, target.source) : undefined),
    [cache, target]
  )
  const bindingKey = binding ? `${target?.key}\0${cache.bindingIdentity(binding)}` : target?.key
  useSyncExternalStore(cache.subscribe, cache.snapshot, cache.snapshot)
  const verificationFailed = !!target && cache.hasFailed(target.item, binding)
  const [refreshCapability, setRefreshCapability] = useState<string | null>(null)
  const checkRefreshCapability = useEffectEvent(() => {
    let cancelled = false
    if (!target) {
      return
    }
    const host = getGitHubSourceRuntimeHost(target.source)
    if (!host) {
      setRefreshCapability(target.key)
      return
    }
    void runtimeEnvironmentSupportsCapability(
      host.environmentId,
      GITHUB_CANONICAL_DETAILS_RUNTIME_CAPABILITY
    )
      .then((supported) => {
        if (!cancelled && target.current()) {
          setRefreshCapability(supported ? target.key : null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRefreshCapability(null)
        }
      })
    return () => {
      cancelled = true
    }
  })
  useEffect(() => checkRefreshCapability(), [target?.key])
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFailure, setRefreshFailure] = useState<{ key: string; message: string } | null>(
    null
  )
  const refreshError =
    refreshFailure?.key === bindingKey
      ? (refreshFailure?.message ?? null)
      : verificationFailed
        ? translate(
            'auto.components.GitHubItemDialog.refreshTaskFailed',
            'Unable to refresh this task. Try again.'
          )
        : null
  const [acceptedRefresh, setAcceptedRefresh] = useState(0)
  const mounted = useMountedRef()
  const onRefreshRef = useRef(onTaskRefresh)
  useLayoutEffect(() => {
    onRefreshRef.current = onTaskRefresh
  }, [onTaskRefresh])
  const intentRef = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      intentRef.current?.()
    },
    [bindingKey]
  )
  const canUseDetailsRepoContext = canUseGitHubRepoContext(repoPath, sourceContext)
  const cacheKey = (canonical: boolean) =>
    workItem && effectiveRepoId && canUseDetailsRepoContext
      ? getWorkItemDetailsCacheKey({
          repoPath: repoPath ?? '',
          repoId: effectiveRepoId,
          issueSourcePreference,
          sourceContext,
          sourceCacheScope:
            sourceContext?.provider === 'github' ? getTaskSourceCacheScope(sourceContext) : null,
          type: workItem.type,
          number: workItem.number,
          ownerRepo: issueRepository,
          canonical,
          bindingKey
        })
      : null
  const canonicalCacheKey = target ? cacheKey(true) : null
  const ordinaryCacheKey = cacheKey(false)
  const detailsCacheKey =
    canonicalCacheKey && workItemDetailsCache.get(canonicalCacheKey)?.route
      ? canonicalCacheKey
      : ordinaryCacheKey
  const optimisticKey = target?.key ?? detailsCacheKey ?? ''
  const refreshTask = useCallback(async () => {
    if (!target || !canonicalCacheKey || !target.current()) {
      return
    }
    intentRef.current?.()
    let live = true
    let attempt: ReturnType<typeof startWorkItemDetailsFetch> | undefined
    let wake = () => {}
    let cancelWait = () => {}
    const disposed = new Promise<void>((resolve) => {
      cancelWait = resolve
    })
    const writes = observeGitHubWorkItemWrites(
      githubTaskWriteKey(target.item, target.source),
      () => {
        attempt?.cancel()
        wake()
      }
    )
    const dispose = () => {
      live = false
      attempt?.cancel()
      writes.dispose()
      unsubscribe()
      cancelWait()
      wake()
      if (intentRef.current === dispose) {
        intentRef.current = null
        if (mounted.current) {
          setRefreshing(false)
        }
      }
    }
    const unsubscribe = useAppStore.subscribe(() => {
      if (!target.current()) {
        dispose()
      }
    })
    intentRef.current = dispose
    setRefreshing(true)
    setRefreshFailure(null)
    try {
      while (live && target.current()) {
        await Promise.race([writes.wait(), disposed])
        if (!live || !target.current()) {
          break
        }
        const interrupted = new Promise<null>((resolve) => {
          wake = () => resolve(null)
        })
        if (!binding) {
          break
        }
        const revision = cache.readRevision(target.item, binding)
        const accepts = () =>
          live &&
          target.current() &&
          cache.current(binding) &&
          cache.readRevision(target.item, binding) === revision &&
          !writes.changed()
        attempt = startWorkItemDetailsFetch(
          canonicalCacheKey,
          () => loadCanonicalGitHubTaskDetails(cache, binding, target, accepts),
          {
            seed: workItemDetailsCache.get(detailsCacheKey ?? ''),
            route: { ownerRepo: target.ownerRepo, bindingKey },
            accepts,
            onAccepted: (result) => {
              // Publication renews Map insertion order, so iterate a snapshot.
              const entries = [...workItemDetailsCache]
              for (const [key, entry] of entries) {
                if (entry.route?.bindingKey === bindingKey && entry.details) {
                  touchWorkItemDetailsCache(key, {
                    ...entry,
                    details: result,
                    fetchedAt: Date.now(),
                    pending: undefined,
                    error: undefined
                  })
                }
              }
              onRefreshRef.current?.(result.item, target)
              if (mounted.current) {
                setAcceptedRefresh((n) => n + 1)
              }
            }
          }
        )
        const outcome = await Promise.race([attempt.settled, interrupted])
        if (!live || !target.current()) {
          break
        }
        if (writes.changed()) {
          continue
        }
        if (outcome?.status !== 'accepted') {
          setRefreshFailure({
            key: bindingKey ?? target.key,
            message: translate(
              'auto.components.GitHubItemDialog.refreshTaskFailed',
              'Unable to refresh this task. Try again.'
            )
          })
        }
        break
      }
    } finally {
      dispose()
    }
  }, [target, canonicalCacheKey, detailsCacheKey, mounted, binding, bindingKey, cache])

  return {
    target,
    detailsCacheKey,
    optimisticKey,
    refreshTask,
    refreshing,
    refreshError,
    acceptedRefresh,
    showRefreshTask: !!target,
    canRefreshTask: !!target && refreshCapability === target.key
  }
}
