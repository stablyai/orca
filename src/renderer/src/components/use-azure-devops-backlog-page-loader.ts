import { useCallback, useEffect, useState, type MutableRefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type {
  AzureDevOpsBacklogColumnField,
  AzureDevOpsBacklogLevel,
  AzureDevOpsBacklogPage
} from '../../../shared/azure-devops/boards-types'
import type { AzureDevOpsTeamRoute } from '../../../shared/azure-devops/boards-repo-resolution'
import type { Repo } from '../../../shared/repo-types'
import type { AzureDevOpsTaskView } from './task-page-azure-devops-team-selection-persistence'
import type { AzureDevOpsViewsStatus } from './task-page-azure-devops-backlog-level-selection'

/** The page carries its repo, so a repo switch drops it with no reset effect. */
type KeyedPage = {
  repoId: string | null
  page: AzureDevOpsBacklogPage | null
  refreshing: boolean
}

/**
 * The backlog page for the selected level: stale-while-revalidate over the slice
 * cache. Status and failures go back to the owning hook, which reports the same
 * status for the team and level stages that precede this one.
 */
export function useAzureDevOpsBacklogPageLoader(args: {
  active: boolean
  repo: Repo | null
  teamRoute: AzureDevOpsTeamRoute | null
  level: AzureDevOpsBacklogLevel | null
  columns: AzureDevOpsBacklogColumnField[]
  view: AzureDevOpsTaskView
  refreshNonce: number
  /** Consumed by the load it triggered, so later level switches go back to the cache. */
  forceNextLoadRef: MutableRefObject<boolean>
  setStatus: (status: AzureDevOpsViewsStatus) => void
  setErrorMessage: (message: string | null) => void
  applyFailure: (error: unknown) => void
}): {
  page: AzureDevOpsBacklogPage | null
  setPage: (page: AzureDevOpsBacklogPage | null) => void
  refreshing: boolean
} {
  const {
    active,
    repo,
    teamRoute,
    level,
    columns,
    view,
    refreshNonce,
    forceNextLoadRef,
    setStatus,
    setErrorMessage,
    applyFailure
  } = args
  const { readAzureDevOpsBacklog, loadAzureDevOpsBacklog } = useAppStore(
    useShallow((s) => ({
      readAzureDevOpsBacklog: s.readAzureDevOpsBacklog,
      loadAzureDevOpsBacklog: s.loadAzureDevOpsBacklog
    }))
  )
  const [loaded, setLoaded] = useState<KeyedPage | null>(null)
  const repoId = repo?.id ?? null
  const current = loaded !== null && loaded.repoId === repoId ? loaded : null

  const setPage = useCallback(
    (page: AzureDevOpsBacklogPage | null) => {
      setLoaded({ repoId, page, refreshing: false })
    },
    [repoId]
  )

  useEffect(() => {
    if (!active || !repo || !teamRoute || !level) {
      return
    }
    if (view === 'board') {
      // Why: the Board owns its own loading and failures; a backlog request here would
      // cost a second page load and could replace a healthy board with its own error.
      setStatus('ready')
      setErrorMessage(null)
      return
    }
    let cancelled = false
    const force = forceNextLoadRef.current
    const cached = readAzureDevOpsBacklog(repo, teamRoute, level)
    const fresh = cached !== null && cached.fresh && !force
    setLoaded((previous) => ({
      repoId: repo.id,
      page:
        cached?.page ?? (previous !== null && previous.repoId === repo.id ? previous.page : null),
      refreshing: !fresh
    }))
    setStatus(cached ? 'ready' : 'loading')
    if (fresh) {
      return
    }
    void loadAzureDevOpsBacklog(repo, teamRoute, level, {
      force: true,
      columnFields: columns.map((c) => c.referenceName)
    })
      .then((page) => {
        if (cancelled) {
          return
        }
        setLoaded({ repoId: repo.id, page, refreshing: false })
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoaded((previous) =>
            previous === null ? previous : { ...previous, refreshing: false }
          )
          applyFailure(error)
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
    teamRoute,
    level,
    columns,
    view,
    refreshNonce,
    forceNextLoadRef,
    readAzureDevOpsBacklog,
    loadAzureDevOpsBacklog,
    setStatus,
    setErrorMessage,
    applyFailure
  ])

  return { page: current?.page ?? null, setPage, refreshing: current?.refreshing ?? false }
}
