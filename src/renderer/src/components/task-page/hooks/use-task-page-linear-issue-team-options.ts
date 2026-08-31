import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from 'react'

import { reconcileLinearTeamSelection } from '@/components/task-page-linear-team-selection'
import {
  buildLinearTeamUrl,
  getLinearOrganizationUrlKeyFromIssueUrl
} from '../../../../../shared/linear/links'
import { resolveLinearIssueAttributeFilterPrimaryTeam } from '@/components/linear-issue-attribute-filter-primary-team'
import {
  shouldClearTeamDerivedFacets,
  teamDerivedFacetsForPrimaryTeamChange,
  type LinearPrimaryTeamObservation
} from '@/components/task-page-linear-issue-request'
import {
  linearIssueAttributeFilterSignature,
  type LinearIssueAttributeFilter
} from '../../../../../shared/linear/issue-attribute-filter'
import { setLinearWorkspaceIssueFilter } from '../../../../../shared/linear/issue-view-resume-state'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { LinearTeam } from '../../../../../shared/linear/workspace-types'
import { LINEAR_ITEM_LIMIT } from '@/components/task-page/task-page-list-limits'

export function useTaskPageLinearIssueTeamOptions({
  displayedLinearIssues,
  availableTeams,
  defaultLinearTeamSelection,
  linearTeamSelection,
  setLinearTeamSelection,
  linearAttributeFilterWorkspaceId,
  setLinearIssueFiltersByWorkspaceId,
  setLinearIssueLimit,
  setLinearIssuePage,
  setLinearIssueLoadingTargetPage,
  linearPrimaryTeamRef,
  linearAttributeFilter
}: {
  displayedLinearIssues: LinearIssue[]
  availableTeams: LinearTeam[]
  defaultLinearTeamSelection: string[] | null | undefined
  linearTeamSelection: ReadonlySet<string>
  setLinearTeamSelection: Dispatch<SetStateAction<ReadonlySet<string>>>
  linearAttributeFilterWorkspaceId: string | null
  setLinearIssueFiltersByWorkspaceId: Dispatch<
    SetStateAction<Record<string, LinearIssueAttributeFilter>>
  >
  setLinearIssueLimit: Dispatch<SetStateAction<number>>
  setLinearIssuePage: Dispatch<SetStateAction<number>>
  setLinearIssueLoadingTargetPage: Dispatch<SetStateAction<number | null>>
  linearPrimaryTeamRef: { current: LinearPrimaryTeamObservation | null }
  linearAttributeFilter: LinearIssueAttributeFilter
}) {
  const linearIssueTeams = useMemo(() => {
    const seen = new Set<string>()
    const teams: LinearTeam[] = []
    for (const issue of displayedLinearIssues) {
      if (!issue.team.id || seen.has(issue.team.id)) {
        continue
      }
      seen.add(issue.team.id)
      teams.push({
        id: issue.team.id,
        workspaceId: issue.workspaceId,
        workspaceName: issue.workspaceName,
        name: issue.team.name,
        key: issue.team.key,
        url:
          buildLinearTeamUrl({
            organizationUrlKey: getLinearOrganizationUrlKeyFromIssueUrl(issue.url),
            teamKey: issue.team.key
          }) ?? undefined
      })
    }
    return teams.sort((a, b) => a.name.localeCompare(b.name))
  }, [displayedLinearIssues])

  // Why: the full team fetch is async and briefly empty; keep the selector usable from issue metadata until the list lands.
  const linearTeamOptions = useMemo(() => {
    if (availableTeams.length === 0) {
      return linearIssueTeams
    }
    const issueTeamById = new Map(linearIssueTeams.map((team) => [team.id, team]))
    return availableTeams.map((team) => {
      if (team.url) {
        return team
      }
      return {
        ...team,
        url: issueTeamById.get(team.id)?.url
      }
    })
  }, [availableTeams, linearIssueTeams])

  // Why: team IDs belong to one workspace, so a workspace switch must not leave the list filtered by stale team IDs.
  useEffect(() => {
    if (linearTeamOptions.length === 0) {
      return
    }
    setLinearTeamSelection(
      reconcileLinearTeamSelection(linearTeamOptions, defaultLinearTeamSelection)
    )
  }, [linearTeamOptions, defaultLinearTeamSelection, setLinearTeamSelection])

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
      setLinearIssueLimit,
      setLinearIssueFiltersByWorkspaceId,
      setLinearIssuePage,
      setLinearIssueLoadingTargetPage
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
    if (!shouldClearTeamDerivedFacets({ previous, next })) {
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

  return {
    linearIssueTeams,
    linearTeamOptions,
    linearAttributePrimaryTeam,
    applyLinearAttributeFilter
  }
}
