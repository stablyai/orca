import { translate } from '@/i18n/i18n'
import { qualifyGitHubTaskLists } from '@/lib/github-task-observation'
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
import { publishGitHubTaskRefresh } from '@/lib/github-task-refresh-publication'
import { captureTaskPageGitHubRefreshMasks } from '@/components/task-page/github/task-page-github-refresh-masks'
import {
  useCallback,
  useLayoutEffect,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState
} from 'react'
import { useAppStore } from '@/store'
import { lookupGitHubWorkItemDetailsForSource } from '@/lib/github-work-item-source-lookup'

import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'

import { getWorkItemDetailsCacheKey, workItemDetailsCache } from './work-item-details-cache'
import { startWorkItemDetailsFetch } from './work-item-details-fetch-settle'
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
    refreshFailure?.key === target?.key ? (refreshFailure?.message ?? null) : null
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
    [target?.key]
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
          bindingKey: target?.key
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
        const retire = captureTaskPageGitHubRefreshMasks(
          target.item,
          target.sources,
          target.observations
        )
        const accepts = () => live && target.current() && !writes.changed()
        attempt = startWorkItemDetailsFetch(
          canonicalCacheKey,
          () =>
            lookupGitHubWorkItemDetailsForSource({
              repoPath: target.repo.path,
              repoId: target.repo.id,
              sourceContext: target.source,
              type: 'issue',
              number: target.item.number,
              ownerRepo: target.ownerRepo,
              canonical: true,
              accepts,
              rpcOptions: target.rpcOptions
            }),
          {
            seed: workItemDetailsCache.get(detailsCacheKey ?? ''),
            route: { ownerRepo: target.ownerRepo, bindingKey: target.key },
            accepts: (result) => {
              if (!accepts()) {
                return false
              }
              if (
                result &&
                !retire(
                  result.item,
                  qualifyGitHubTaskLists(
                    { ...result.item, githubObservation: target.observation },
                    target.observation
                  )
                )
              ) {
                throw new Error('Task changed during refresh. Try again.')
              }
              return true
            },
            onAccepted: (result) => {
              publishGitHubTaskRefresh(target, result, onRefreshRef.current)
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
            key: target.key,
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
  }, [target, canonicalCacheKey, detailsCacheKey, mounted])

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
