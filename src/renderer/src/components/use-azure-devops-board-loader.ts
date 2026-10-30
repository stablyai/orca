import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { azureDevOpsBoardKey } from '@/store/slices/azure-devops-boards'
import type {
  AzureDevOpsBacklogLevel,
  AzureDevOpsBoardPage
} from '../../../shared/azure-devops/boards-types'
import type { AzureDevOpsTeamRoute } from '../../../shared/azure-devops/boards-repo-resolution'
import type { Repo } from '../../../shared/repo-types'
import { resolveAzureDevOpsLoadFailure } from './task-page-azure-devops-backlog-level-selection'

export type AzureDevOpsBoardLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** How the load failed, so the page can show the same notice the backlog does. */
export type AzureDevOpsBoardErrorStatus = ReturnType<typeof resolveAzureDevOpsLoadFailure>['status']

const NO_COLLAPSED_LANES: ReadonlySet<string> = new Set()

/** Loaded page and collapsed lanes carry their key, so a team or level switch drops both. */
type KeyedBoard = {
  key: string
  status: Exclude<AzureDevOpsBoardLoadStatus, 'idle'>
  page: AzureDevOpsBoardPage | null
  errorStatus: AzureDevOpsBoardErrorStatus | null
  errorMessage: string | null
}

/**
 * Board page for the selected level, loaded only while the Board view is shown.
 * A resolved `null` page means the level has no board; every other failure rejects.
 */
export function useAzureDevOpsBoardLoader(args: {
  active: boolean
  repo: Repo | null
  teamRoute: AzureDevOpsTeamRoute | null
  level: AzureDevOpsBacklogLevel | null
  view: 'backlog' | 'board'
}): {
  board: AzureDevOpsBoardPage | null
  status: AzureDevOpsBoardLoadStatus
  errorStatus: AzureDevOpsBoardErrorStatus | null
  errorMessage: string | null
  refresh: () => void
  collapsedLaneIds: ReadonlySet<string>
  toggleLane: (laneId: string) => void
} {
  const { active, repo, teamRoute, level, view } = args
  const { readAzureDevOpsBoard, loadAzureDevOpsBoard } = useAppStore(
    useShallow((s) => ({
      readAzureDevOpsBoard: s.readAzureDevOpsBoard,
      loadAzureDevOpsBoard: s.loadAzureDevOpsBoard
    }))
  )

  const [loaded, setLoaded] = useState<KeyedBoard | null>(null)
  const [lanes, setLanes] = useState<{ key: string; ids: ReadonlySet<string> } | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  // Why: consumed by the load it triggered, so a later view switch goes back to the cache.
  const forceNextLoadRef = useRef(false)

  const key = repo && teamRoute && level ? azureDevOpsBoardKey(repo, teamRoute, level.id) : null
  const current = loaded !== null && loaded.key === key ? loaded : null

  useEffect(() => {
    if (!active || !repo || !teamRoute || !level || key === null || view !== 'board') {
      return
    }
    let cancelled = false
    const force = forceNextLoadRef.current
    const cached = readAzureDevOpsBoard(repo, teamRoute, level)
    // A refresh keeps the current cards on screen while the reload runs.
    setLoaded((previous) => ({
      key,
      status: cached !== null && !force ? 'ready' : 'loading',
      page: cached ?? (previous !== null && previous.key === key ? previous.page : null),
      errorStatus: null,
      errorMessage: null
    }))
    // Why: the slice honours its own TTL, so an unforced call is a no-op on a fresh cache.
    void loadAzureDevOpsBoard(repo, teamRoute, level, { force })
      .then((page) => {
        if (!cancelled) {
          setLoaded({ key, status: 'ready', page, errorStatus: null, errorMessage: null })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          // Why: an unreachable SSH host is not a board failure; the page shows its own notice.
          const failure = resolveAzureDevOpsLoadFailure(error)
          setLoaded({
            key,
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
    teamRoute,
    level,
    key,
    view,
    refreshNonce,
    readAzureDevOpsBoard,
    loadAzureDevOpsBoard
  ])

  const refresh = useCallback(() => {
    forceNextLoadRef.current = true
    setRefreshNonce((n) => n + 1)
  }, [])

  const toggleLane = useCallback(
    (laneId: string) => {
      if (key === null) {
        return
      }
      setLanes((item) => {
        const ids = new Set(item !== null && item.key === key ? item.ids : [])
        if (!ids.delete(laneId)) {
          ids.add(laneId)
        }
        return { key, ids }
      })
    },
    [key]
  )

  return {
    board: current?.page ?? null,
    status: current?.status ?? 'idle',
    errorStatus: current?.errorStatus ?? null,
    errorMessage: current?.errorMessage ?? null,
    refresh,
    collapsedLaneIds: lanes !== null && lanes.key === key ? lanes.ids : NO_COLLAPSED_LANES,
    toggleLane
  }
}
