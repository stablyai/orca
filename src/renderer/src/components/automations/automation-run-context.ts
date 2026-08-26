import {
  buildWorkspaceRunContext,
  type WorkspaceRunContext
} from '../../../../shared/task-source-context'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'

export function buildAutomationRunContextForRepo(args: {
  repoId: string
  repos: readonly Repo[]
  projectHostSetups: readonly ProjectHostSetup[]
}): WorkspaceRunContext | null {
  const matchingRepos = args.repos.filter((candidate) => candidate.id === args.repoId)
  if (matchingRepos.length !== 1) {
    return null
  }
  const repo = matchingRepos[0]
  const hostId = getRepoExecutionHostId(repo)
  const setup = args.projectHostSetups.find(
    (candidate) =>
      candidate.repoId === repo.id &&
      candidate.hostId === hostId &&
      candidate.setupState === 'ready'
  )
  if (!setup) {
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
