import {
  buildWorkspaceRunContext,
  type WorkspaceRunContext
} from '../../../../shared/task-source-context'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'

export function buildAutomationRunContextForRepo(args: {
  repoId: string
  repos: readonly Repo[]
  projectHostSetups: readonly ProjectHostSetup[]
}): WorkspaceRunContext | null {
  const setup = args.projectHostSetups.find(
    (candidate) => candidate.repoId === args.repoId && candidate.setupState === 'ready'
  )
  if (!setup) {
    return null
  }
  const repo = args.repos.find((candidate) => candidate.id === setup.repoId)
  if (!repo) {
    return null
  }
  return buildWorkspaceRunContext({
    projectId: setup.projectId,
    hostId: setup.hostId,
    projectHostSetupId: setup.id,
    repoId: setup.repoId,
    path: setup.path || repo.path
  })
}
