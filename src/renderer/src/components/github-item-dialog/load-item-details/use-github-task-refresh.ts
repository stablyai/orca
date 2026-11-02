import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import {
  getGitHubSourceRuntimeHost,
  canUseGitHubRepoContext
} from '@/lib/github-source-runtime-context'
import { GITHUB_CANONICAL_DETAILS_RUNTIME_CAPABILITY } from '../../../../../shared/task-source-runtime-capabilities'
import { githubTaskExecutionIdentity, captureGitHubTaskTarget } from '@/lib/github-task-target'
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

import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'

import { getWorkItemDetailsCacheKey, workItemDetailsCache } from './work-item-details-cache'
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
  onAccepted
}: {
  workItem: GitHubWorkItem | null
  repoPath: string | null
  effectiveRepoId: string | null
  sourceContext?: TaskSourceContext | null
  issueRepository: GitHubOwnerRepo | null
  onAccepted?: (item: GitHubWorkItem) => void
}) {
  const registeredRepo = useAppStore((s) =>
    workItem
      ? getWorkItemRepo(s.repos, {
          ...workItem,
          repoHostId: workItem.repoHostId ?? sourceContext?.hostId
        })
      : undefined
  )
  // A reconnect re-captures the binding (the fence each read and send carries); the target and its data keys stay.
  const executionIdentity = useAppStore(() => githubTaskExecutionIdentity(registeredRepo))
  const issueSourcePreference = registeredRepo?.issueSourcePreference
  const target = useMemo(
    () =>
      workItem?.type === 'issue' && sourceContext && registeredRepo
        ? captureGitHubTaskTarget(useAppStore.getState, workItem, sourceContext)
        : null,
    [workItem, sourceContext, registeredRepo]
  )
  const cache = useAppStore((s) => s.githubTaskCache)
  const { binding } = useMemo(
    () => ({
      executionIdentity,
      binding: target ? cache.capture(target.repo, target.source) : undefined
    }),
    [cache, target, executionIdentity]
  )
  const bindingKey = binding ? `${target?.key}\0${cache.bindingIdentity(binding)}` : target?.key
  // Disabled until known for this connection; a server known to lack canonical details explains why in the tooltip.
  const capabilityKey = target && `${target.key}\0${executionIdentity}`
  const [refreshCapability, setRefreshCapability] = useState<{
    key: string
    supported: boolean
  } | null>(null)
  const checkRefreshCapability = useEffectEvent(() => {
    let cancelled = false
    if (!target || !capabilityKey) {
      return
    }
    const host = getGitHubSourceRuntimeHost(target.source)
    if (!host) {
      setRefreshCapability({ key: capabilityKey, supported: true })
      return
    }
    const checked = binding
    void runtimeEnvironmentSupportsCapability(
      host.environmentId,
      GITHUB_CANONICAL_DETAILS_RUNTIME_CAPABILITY
    )
      .then((supported) => {
        if (!cancelled && checked && cache.current(checked)) {
          setRefreshCapability({ key: capabilityKey, supported })
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
  useEffect(() => checkRefreshCapability(), [capabilityKey])
  const capability = refreshCapability?.key === capabilityKey ? refreshCapability : null
  const [refreshing, setRefreshing] = useState(false)
  const [acceptedRefresh, setAcceptedRefresh] = useState(0)
  const mounted = useMountedRef()
  const onAcceptedRef = useRef(onAccepted)
  useLayoutEffect(() => {
    onAcceptedRef.current = onAccepted
  }, [onAccepted])
  const intentRef = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      intentRef.current?.()
    },
    [bindingKey]
  )
  const canUseDetailsRepoContext = canUseGitHubRepoContext(repoPath, sourceContext)
  // Refresh writes the same entry ordinary loads use; only its own read is fresh and strict.
  const detailsCacheKey =
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
          bindingKey
        })
      : null
  const optimisticKey = target?.key ?? detailsCacheKey ?? ''
  const refreshTask = useCallback(async () => {
    if (!target || !binding || !detailsCacheKey || !cache.current(binding)) {
      return
    }
    intentRef.current?.()
    let live = true
    let attempt: ReturnType<typeof startWorkItemDetailsFetch> | undefined
    let wake = () => {}
    // The record's own pending edits and write revision fence this read; no second registry.
    const unsubscribeCache = cache.subscribe(() => wake())
    const unsubscribeStore = useAppStore.subscribe(() => {
      if (!cache.current(binding)) {
        dispose()
      }
    })
    const dispose = () => {
      live = false
      attempt?.cancel()
      unsubscribeCache()
      unsubscribeStore()
      wake()
      if (intentRef.current === dispose) {
        intentRef.current = null
        if (mounted.current) {
          setRefreshing(false)
        }
      }
    }
    const alive = () => live && cache.current(binding)
    intentRef.current = dispose
    setRefreshing(true)
    try {
      while (alive()) {
        if (cache.isPending(target.item, binding)) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          continue
        }
        const loading = workItemDetailsCache.get(detailsCacheKey)?.pending
        if (loading) {
          // The ordinary load keeps its lenient result; the strict read runs once it settles.
          await Promise.race([
            loading.catch(() => null),
            new Promise<void>((resolve) => {
              wake = resolve
            })
          ])
          continue
        }
        const revision = cache.readRevision(target.item, binding)
        const accepts = () => alive() && cache.readRevision(target.item, binding) === revision
        attempt = startWorkItemDetailsFetch(
          detailsCacheKey,
          () => loadCanonicalGitHubTaskDetails(cache, binding, target, accepts),
          {
            userAction: true,
            accepts,
            onAccepted: (result) => {
              onAcceptedRef.current?.({ ...target.item, ...result.item })
              if (mounted.current) {
                setAcceptedRefresh((n) => n + 1)
              }
            }
          }
        )
        const outcome = await attempt.settled
        if (!alive()) {
          break
        }
        // An edit or details invalidation that crossed this read restarts it after pending edits settle.
        if (
          outcome.status === 'superseded' ||
          cache.readRevision(target.item, binding) !== revision
        ) {
          continue
        }
        // Each failed click reports once here; the entry keeps whatever it already showed.
        if (outcome.status !== 'accepted') {
          toast.error(
            translate(
              'auto.components.GitHubItemDialog.refreshTaskFailed',
              'Unable to refresh this task. Try again.'
            )
          )
        }
        break
      }
    } finally {
      dispose()
    }
  }, [target, detailsCacheKey, mounted, binding, cache])

  return {
    binding,
    detailsCacheKey,
    optimisticKey,
    refreshTask,
    refreshing,
    acceptedRefresh,
    showRefreshTask: !!target,
    canRefreshTask: !!binding && !!capability?.supported,
    refreshUnsupported: capability?.supported === false
  }
}
