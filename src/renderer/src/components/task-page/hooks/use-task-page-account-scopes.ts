import { useMemo } from 'react'

import type { JiraConnectionStatus } from '../../../../../shared/jira-types'
import type { LinearConnectionStatus } from '../../../../../shared/linear/workspace-types'

export function useTaskPageAccountScopes({
  linearStatus,
  jiraStatus
}: {
  linearStatus: LinearConnectionStatus
  jiraStatus: JiraConnectionStatus
}) {
  const linearWorkspaces = useMemo(() => linearStatus.workspaces ?? [], [linearStatus.workspaces])
  const selectedLinearWorkspaceId =
    linearStatus.selectedWorkspaceId ??
    linearStatus.activeWorkspaceId ??
    linearWorkspaces[0]?.id ??
    null
  const selectedLinearWorkspace =
    selectedLinearWorkspaceId && selectedLinearWorkspaceId !== 'all'
      ? (linearWorkspaces.find((workspace) => workspace.id === selectedLinearWorkspaceId) ?? null)
      : null
  const jiraSites = useMemo(() => jiraStatus.sites ?? [], [jiraStatus.sites])
  const selectedJiraSiteId =
    jiraStatus.selectedSiteId ?? jiraStatus.activeSiteId ?? jiraSites[0]?.id ?? null
  const selectedJiraSite =
    selectedJiraSiteId && selectedJiraSiteId !== 'all'
      ? (jiraSites.find((site) => site.id === selectedJiraSiteId) ?? null)
      : null

  return {
    linearWorkspaces,
    selectedLinearWorkspaceId,
    selectedLinearWorkspace,
    jiraSites,
    selectedJiraSiteId,
    selectedJiraSite
  }
}
