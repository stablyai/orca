import { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { LinearProjectSummary } from '../../../shared/linear/project-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { defaultScopeSource } from '@/lib/default-creation-host'
import { linearListProjects } from '@/runtime/runtime-linear-project-client'

/** Projects offered by the new Linear issue dialog for its target team. */
export function useNewLinearIssueProjects(args: {
  open: boolean
  targetTeam: { workspaceId?: string | null } | null
  selectedLinearWorkspaceId: string
  linearTaskSourceContext: TaskSourceContext | null
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
}) {
  const { open, targetTeam, selectedLinearWorkspaceId, linearTaskSourceContext, settings } = args
  const [newLinearIssueProjects, setNewLinearIssueProjects] = useState<LinearProjectSummary[]>([])
  const [newLinearIssueProjectsLoading, setNewLinearIssueProjectsLoading] = useState(false)
  useEffect(() => {
    let cancelled = false
    if (!open || !targetTeam) {
      setNewLinearIssueProjects([])
      setNewLinearIssueProjectsLoading(false)
      return
    }
    setNewLinearIssueProjectsLoading(true)
    const targetWorkspaceId =
      targetTeam.workspaceId ||
      (selectedLinearWorkspaceId !== 'all' ? selectedLinearWorkspaceId : null)
    // Why: with no Tasks source chosen, the list comes from the default scope host.
    const source = linearTaskSourceContext ?? defaultScopeSource(settings)
    linearListProjects(source, undefined, 100, targetWorkspaceId)
      .then((p) => {
        if (!cancelled) {
          setNewLinearIssueProjects(p.items)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setNewLinearIssueProjectsLoading(false)
        }
      })
    return () => {
      // Why: project lists are workspace-scoped; stale responses must not populate the composer after a team/workspace switch.
      cancelled = true
    }
  }, [open, targetTeam, linearTaskSourceContext, settings, selectedLinearWorkspaceId])
  return {
    newLinearIssueProjects,
    setNewLinearIssueProjects,
    newLinearIssueProjectsLoading,
    setNewLinearIssueProjectsLoading
  }
}
