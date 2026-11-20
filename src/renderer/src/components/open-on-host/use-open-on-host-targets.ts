import { useMemo } from 'react'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host/execution-host-registry'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { getHostDisplayLabelOverrides } from '../../../../shared/execution-host/host-setting-overrides'
import { getNewWorkspaceDialogEligibleRepos } from '../../../../shared/new-workspace/new-workspace-dialog-repo'
import type { Repo } from '../../../../shared/repository/repo-types'
import { useTranslate } from '@/i18n/use-translate'
import { resolveProjectCloneUrlPrefill } from '@/lib/workspace/creation/project-clone-url-prefill'
import { getRepoWorkspaceCreationTargetHint } from '@/lib/workspace/creation/project-host-workspace-target'
import { useAppStore } from '@/store'
import { useRuntimeStatusByEnvironmentId } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { listOpenOnHostTargets } from './open-on-host-targets'

/** The hosts a repo (or one of its workspaces) can open on, with the inputs the flow needs. */
export function useOpenOnHostTargets(repo: Repo | null | undefined, requireBranchReuse: boolean) {
  const t = useTranslate()
  const repos = useAppStore((s) => s.repos)
  const projects = useAppStore((s) => s.projects)
  const projectHostSetups = useAppStore((s) => s.projectHostSetups)
  const settings = useAppStore((s) => s.settings)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useRuntimeStatusByEnvironmentId()

  return useMemo(() => {
    if (!repo) {
      return null
    }
    const sourceHostId = getRepoExecutionHostId(repo)
    const { projectId } = getRepoWorkspaceCreationTargetHint(repo, projectHostSetups)
    const cloneUrl = resolveProjectCloneUrlPrefill(projects, repos, projectId)
    const hosts = buildExecutionHostRegistry({
      repos,
      settings,
      hostSource: 'configured-only',
      sshTargetLabels,
      sshConnectionStates,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId,
      hostLabelOverrides: getHostDisplayLabelOverrides(settings)
    })
    const targets = listOpenOnHostTargets(
      {
        projectId,
        sourceHostId,
        projectHostSetups,
        eligibleRepos: getNewWorkspaceDialogEligibleRepos(repos),
        hosts,
        cloneUrl,
        requireBranchReuse
      },
      t
    )
    return { sourceHostId, projectId, cloneUrl, targets }
  }, [
    repo,
    requireBranchReuse,
    t,
    repos,
    projects,
    projectHostSetups,
    settings,
    sshTargetLabels,
    sshConnectionStates,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId
  ])
}
