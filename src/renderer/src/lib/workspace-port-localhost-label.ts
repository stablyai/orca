import type { LocalhostWorktreeLabelRoute } from '../../../shared/localhost-worktree-labels'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Project } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import type { WorkspacePort } from '../../../shared/workspace-ports'
import { browserUrlForPort } from './workspace-port-urls'

export function localhostWorktreeLabelRouteForPort({
  port,
  repo,
  project,
  settings
}: {
  port: WorkspacePort
  repo: Repo | null | undefined
  project?: Project | null
  settings: Pick<GlobalSettings, 'localhostWorktreeLabelsEnabled'> | null | undefined
}): LocalhostWorktreeLabelRoute | null {
  if (settings?.localhostWorktreeLabelsEnabled !== true || port.kind !== 'workspace' || !repo) {
    return null
  }
  const projectSource = project ?? repo
  return {
    targetUrl: browserUrlForPort(port),
    projectName: projectSource.displayName,
    worktreeName: port.owner.displayName,
    // Pass owner.path like terminal/runtime builders or getLocalhostWorktreeHostLabel derives a different slug.
    worktreePath: port.owner.path,
    repoId: repo.id,
    worktreeId: port.owner.worktreeId
  }
}
