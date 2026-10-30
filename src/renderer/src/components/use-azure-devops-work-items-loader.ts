import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AzureDevOpsRepoIdentity } from '@/store/slices/azure-devops-boards'
import type {
  AzureDevOpsAssignedWorkItemsPage,
  AzureDevOpsWorkItem
} from '../../../shared/azure-devops/boards-types'
import type { Repo } from '../../../shared/repo-types'
import { resolveAzureDevOpsLoadFailure } from './task-page-azure-devops-backlog-level-selection'
import type { AzureDevOpsTaskView } from './task-page-azure-devops-team-selection-persistence'

export type AzureDevOpsWorkItemsLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** How the load failed, so the page can show the same host notices the backlog does. */
export type AzureDevOpsWorkItemsErrorStatus = ReturnType<
  typeof resolveAzureDevOpsLoadFailure
>['status']

const NO_ITEMS: AzureDevOpsWorkItem[] = []

/** The loaded page carries its repo, so a repo switch drops it with no reset effect. */
type KeyedWorkItems = {
  repoId: string
  status: Exclude<AzureDevOpsWorkItemsLoadStatus, 'idle'>
  page: AzureDevOpsAssignedWorkItemsPage | null
  errorStatus: AzureDevOpsWorkItemsErrorStatus | null
  errorMessage: string | null
}

/**
 * The project's work items assigned to the signed-in user, loaded only while the
 * Work items view is shown. No team or level: this view is scoped by project alone.
 */
export function useAzureDevOpsWorkItemsLoader(args: {
  active: boolean
  repo: Repo | null
  view: AzureDevOpsTaskView
}): {
  items: AzureDevOpsWorkItem[]
  unhydratedItemCount: number
  /** The query's own result bound when the list came back at it; null otherwise. */
  truncatedAtQueryLimit: number | null
  status: AzureDevOpsWorkItemsLoadStatus
  errorStatus: AzureDevOpsWorkItemsErrorStatus | null
  errorMessage: string | null
  refresh: () => void
  refreshing: boolean
} {
  const { active, view } = args
  // Why: updateRepo replaces the Repo object on changes this loader does not care about.
  const repoId = args.repo?.id ?? null
  const repoPath = args.repo?.path ?? null
  const repoConnectionId = args.repo?.connectionId ?? null
  const repo = useMemo<AzureDevOpsRepoIdentity | null>(
    () =>
      repoId === null || repoPath === null
        ? null
        : { id: repoId, path: repoPath, connectionId: repoConnectionId },
    [repoId, repoPath, repoConnectionId]
  )
  const { readAzureDevOpsAssignedWorkItems, loadAzureDevOpsAssignedWorkItems } = useAppStore(
    useShallow((s) => ({
      readAzureDevOpsAssignedWorkItems: s.readAzureDevOpsAssignedWorkItems,
      loadAzureDevOpsAssignedWorkItems: s.loadAzureDevOpsAssignedWorkItems
    }))
  )

  const [loaded, setLoaded] = useState<KeyedWorkItems | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  // Why: consumed by the load it triggered, so a later view switch goes back to the cache.
  const forceNextLoadRef = useRef(false)
  const current = loaded !== null && loaded.repoId === repoId ? loaded : null

  useEffect(() => {
    if (!active || !repo || view !== 'workItems') {
      return
    }
    let cancelled = false
    const force = forceNextLoadRef.current
    const cached = readAzureDevOpsAssignedWorkItems(repo)
    // A refresh keeps the current rows on screen while the reload runs.
    setLoaded((previous) => ({
      repoId: repo.id,
      status: cached !== null && cached.fresh && !force ? 'ready' : 'loading',
      page:
        cached?.page ?? (previous !== null && previous.repoId === repo.id ? previous.page : null),
      errorStatus: null,
      errorMessage: null
    }))
    // Why: the slice honours its own TTL, so an unforced call is a no-op on a fresh cache.
    void loadAzureDevOpsAssignedWorkItems(repo, { force })
      .then((page) => {
        if (!cancelled) {
          setLoaded({
            repoId: repo.id,
            status: 'ready',
            page,
            errorStatus: null,
            errorMessage: null
          })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          // Why: an unreachable SSH host is not a query failure; the page shows its own notice.
          const failure = resolveAzureDevOpsLoadFailure(error)
          setLoaded({
            repoId: repo.id,
            status: 'error',
            page: null,
            errorStatus: failure.status,
            errorMessage: failure.message
          })
        }
      })
      .finally(() => {
        if (!cancelled) {
          forceNextLoadRef.current = false
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    active,
    repo,
    view,
    refreshNonce,
    readAzureDevOpsAssignedWorkItems,
    loadAzureDevOpsAssignedWorkItems
  ])

  const refresh = useCallback(() => {
    forceNextLoadRef.current = true
    setRefreshNonce((n) => n + 1)
  }, [])

  return {
    items: current?.page?.items ?? NO_ITEMS,
    unhydratedItemCount: current?.page?.unhydratedItemCount ?? 0,
    truncatedAtQueryLimit: current?.page?.truncatedAtQueryLimit ?? null,
    status: current?.status ?? 'idle',
    errorStatus: current?.errorStatus ?? null,
    errorMessage: current?.errorMessage ?? null,
    refresh,
    refreshing: current?.status === 'loading'
  }
}
