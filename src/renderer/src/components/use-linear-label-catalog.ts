import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  linearListIssueLabels,
  type LinearIssueLabelListOptions,
  type RuntimeLinearSettings
} from '@/runtime/runtime-linear-client'
import type { LinearIssueLabel, LinearTeam, LinearWorkspaceSelection } from '../../../shared/types'
import {
  getLinearLabelsWorkspaceViewState,
  reconcileSelectedLinearLabelTeamId
} from './linear-label-form-model'

export function useLinearLabelCatalog({
  settings,
  workspaceId,
  teams
}: {
  settings: RuntimeLinearSettings
  workspaceId: LinearWorkspaceSelection | null
  teams: LinearTeam[]
}) {
  const [labels, setLabels] = useState<LinearIssueLabel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [selectedTeamId, setSelectedTeamId] = useState('all')
  const [refreshNonce, setRefreshNonce] = useState(0)
  const requestSeqRef = useRef(0)

  const effectiveSelectedTeamId = reconcileSelectedLinearLabelTeamId(selectedTeamId, teams)
  const selectedTeam =
    effectiveSelectedTeamId === 'all'
      ? null
      : teams.find((team) => team.id === effectiveSelectedTeamId)
  const selectedTeamUrl = selectedTeam?.url ?? null

  const loadLabels = useCallback(() => {
    const requestSeq = requestSeqRef.current + 1
    requestSeqRef.current = requestSeq
    setLoading(true)
    setError(null)
    const options: LinearIssueLabelListOptions = {
      workspaceId: workspaceId ?? undefined,
      teamId: effectiveSelectedTeamId === 'all' ? undefined : effectiveSelectedTeamId,
      includeArchived
    }
    void linearListIssueLabels(settings, options)
      .then((next) => {
        if (requestSeqRef.current === requestSeq) {
          setLabels(next)
        }
      })
      .catch((err) => {
        if (requestSeqRef.current === requestSeq) {
          setError(err instanceof Error ? err.message : 'Failed to load Linear labels')
        }
      })
      .finally(() => {
        if (requestSeqRef.current === requestSeq) {
          setLoading(false)
        }
      })
  }, [effectiveSelectedTeamId, includeArchived, settings, workspaceId])

  useEffect(() => {
    loadLabels()
  }, [loadLabels, refreshNonce])

  useEffect(() => {
    setSelectedTeamId('all')
  }, [workspaceId])

  useEffect(() => {
    setSelectedTeamId((current) => reconcileSelectedLinearLabelTeamId(current, teams))
  }, [teams])

  const viewState = useMemo(
    () => getLinearLabelsWorkspaceViewState({ loading, error, labels }),
    [error, labels, loading]
  )

  return {
    labels,
    loading,
    error,
    includeArchived,
    setIncludeArchived,
    effectiveSelectedTeamId,
    setSelectedTeamId,
    selectedTeam,
    selectedTeamUrl,
    viewState,
    refresh: () => setRefreshNonce((current) => current + 1)
  }
}
