import { useEffect, useState } from 'react'

import type { LinearTeam } from '../../../../../shared/linear/workspace-types'
import type { TaskProvider } from '../../../../../shared/task-providers'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { LinearSlice } from '@/store/slices/linear'

export function useTaskPageLinearTeams({
  taskResumeApplied,
  taskSource,
  linearConnected,
  selectedLinearWorkspaceId,
  getCachedLinearTeams,
  linearTaskSourceContext,
  listLinearTeams
}: {
  taskResumeApplied: boolean
  taskSource: TaskProvider
  linearConnected: boolean
  selectedLinearWorkspaceId: string | null
  getCachedLinearTeams: LinearSlice['getCachedLinearTeams']
  linearTaskSourceContext: TaskSourceContext | null
  listLinearTeams: LinearSlice['listLinearTeams']
}) {
  // Why: fetch the full Linear team list so the selector shows all teams, not just those with issues in the fetch window.
  const [availableTeams, setAvailableTeams] = useState<LinearTeam[]>([])
  const [linearTeamRefreshNonce, setLinearTeamRefreshNonce] = useState(0)

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'linear' || !linearConnected) {
      setAvailableTeams([])
      return
    }
    let cancelled = false
    const cachedTeams = getCachedLinearTeams(selectedLinearWorkspaceId, {
      sourceContext: linearTaskSourceContext
    })
    // Why: on a workspace switch, drop the prior workspace's teams during the pending fetch but seed from the workspace-scoped cache.
    setAvailableTeams(cachedTeams ?? [])
    void listLinearTeams(selectedLinearWorkspaceId, { sourceContext: linearTaskSourceContext })
      .then((teams) => {
        if (!cancelled) {
          setAvailableTeams(teams)
        }
      })
      .catch(() => {
        if (!cancelled) {
          console.warn('[TaskPage] Failed to fetch Linear teams')
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    taskSource,
    linearConnected,
    selectedLinearWorkspaceId,
    linearTeamRefreshNonce,
    taskResumeApplied,
    getCachedLinearTeams,
    listLinearTeams,
    linearTaskSourceContext
  ])

  return {
    availableTeams,
    setAvailableTeams,
    linearTeamRefreshNonce,
    setLinearTeamRefreshNonce
  }
}
