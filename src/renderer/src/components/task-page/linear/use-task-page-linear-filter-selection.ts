import type { TaskPageLinearListSelectionPreludeModel } from './use-task-page-linear-list-selection'
import { useMemo, useCallback, useEffect } from 'react'
import { resolveLinearIssueAttributeFilterPrimaryTeam } from '@/components/linear-issue-attribute-filter-primary-team'
import {
  type LinearIssueAttributeFilter,
  linearIssueAttributeFilterSignature
} from '../../../../../shared/linear/issue-attribute-filter'
import { setLinearWorkspaceIssueFilter } from '../../../../../shared/linear/issue-view-resume-state'
import { LINEAR_ITEM_LIMIT } from '../task-page-source-context'
import {
  type LinearPrimaryTeamObservation,
  shouldClearTeamDerivedFacets,
  teamDerivedFacetsForPrimaryTeamChange,
  isLinearIssueSearchActive
} from '@/components/task-page/linear/task-page-linear-issue-request'
export function useTaskPageLinearFilterSelection(model: TaskPageLinearListSelectionPreludeModel) {
  const {
    linearMode,
    setLinearIssueLimit,
    setLinearIssuePage,
    setLinearIssueLoadingTargetPage,
    linearSearchInput,
    appliedLinearSearch,
    setLinearIssueFiltersByWorkspaceId,
    linearAttributeFilterWorkspaceId,
    linearAttributeFilter,
    linearPrimaryTeamRef,
    availableTeams,
    linearTeamSelection,
    activeLinearIssueContextLabel,
    linearTeamOptions
  } = model
  const linearAttributePrimaryTeam = useMemo(
    () =>
      resolveLinearIssueAttributeFilterPrimaryTeam({
        selectedTeamIds: [...linearTeamSelection],
        availableTeams: linearTeamOptions
      }),
    [linearTeamOptions, linearTeamSelection]
  )
  const applyLinearAttributeFilter = useCallback(
    (next: LinearIssueAttributeFilter) => {
      if (linearAttributeFilterWorkspaceId) {
        setLinearIssueFiltersByWorkspaceId((previous) =>
          setLinearWorkspaceIssueFilter(previous, linearAttributeFilterWorkspaceId, next)
        )
      }
      setLinearIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearIssuePage(0)
      setLinearIssueLoadingTargetPage(null)
    },
    [
      linearAttributeFilterWorkspaceId,
      setLinearIssuePage,
      setLinearIssueFiltersByWorkspaceId,
      setLinearIssueLoadingTargetPage,
      setLinearIssueLimit
    ]
  )
  useEffect(() => {
    const nextTeamId = availableTeams.length > 0 ? (linearAttributePrimaryTeam?.id ?? null) : null
    if (!nextTeamId) {
      return
    }
    const previous = linearPrimaryTeamRef.current
    const next: LinearPrimaryTeamObservation = {
      workspaceId: linearAttributeFilterWorkspaceId,
      teamId: nextTeamId
    }
    linearPrimaryTeamRef.current = next
    if (
      !shouldClearTeamDerivedFacets({
        previous,
        next
      })
    ) {
      return
    }
    // Why: team-scoped facets; clearing them is a filter change, so reset limit/page via applyLinearAttributeFilter (R6), not a bare set.
    const cleared = teamDerivedFacetsForPrimaryTeamChange(linearAttributeFilter)
    if (
      linearIssueAttributeFilterSignature(linearAttributeFilter) ===
      linearIssueAttributeFilterSignature(cleared)
    ) {
      return
    }
    applyLinearAttributeFilter(cleared)
  }, [
    applyLinearAttributeFilter,
    availableTeams.length,
    linearAttributeFilter,
    linearAttributeFilterWorkspaceId,
    linearAttributePrimaryTeam?.id,
    linearPrimaryTeamRef
  ])
  const linearSearchActive = isLinearIssueSearchActive(linearSearchInput, appliedLinearSearch)
  const showLinearAttributeFilters =
    linearMode === 'issues' && !activeLinearIssueContextLabel && !linearSearchActive

  const nextModel = model as typeof model & {
    linearAttributePrimaryTeam: typeof linearAttributePrimaryTeam
    applyLinearAttributeFilter: typeof applyLinearAttributeFilter
    linearSearchActive: typeof linearSearchActive
    showLinearAttributeFilters: typeof showLinearAttributeFilters
  }
  nextModel.linearAttributePrimaryTeam = linearAttributePrimaryTeam
  nextModel.applyLinearAttributeFilter = applyLinearAttributeFilter
  nextModel.linearSearchActive = linearSearchActive
  nextModel.showLinearAttributeFilters = showLinearAttributeFilters
  return nextModel
}
export type TaskPageLinearFilterSelectionModel = ReturnType<typeof useTaskPageLinearFilterSelection>
