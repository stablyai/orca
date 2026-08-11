import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectGroup, Repo } from '../../../../shared/types'
import {
  resolveProjectGroupPathStatusSourceHostId,
  resolveRepoPathStatusSourceHostId
} from '../../lib/folder-workspace-path-status-request'
import { selectProjectGroupRemovalTargets } from '../../store/slices/project-group-removal-targets'
import { getProjectGroupExecutionHostIdForRows } from './worktree-list-host-filtering'

export function getProjectGroupDeletePreview(args: {
  groupId: string
  hostId?: ExecutionHostId
  sourceExecutionHostId?: ExecutionHostId
  defaultHostId: ExecutionHostId
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}): ReturnType<typeof selectProjectGroupRemovalTargets> & { projectNames: string[] } {
  const candidateProjectGroups = args.hostId
    ? args.projectGroups.filter(
        (group) =>
          getProjectGroupExecutionHostIdForRows(group, args.defaultHostId) === args.hostId &&
          (!args.sourceExecutionHostId ||
            resolveProjectGroupPathStatusSourceHostId(group) === args.sourceExecutionHostId)
      )
    : args.projectGroups
  const candidateRepos = args.hostId
    ? args.repos.filter(
        (repo) =>
          getRepoExecutionHostId(repo) === args.hostId &&
          (!args.sourceExecutionHostId ||
            resolveRepoPathStatusSourceHostId(repo) === args.sourceExecutionHostId)
      )
    : args.repos
  const targets = selectProjectGroupRemovalTargets(
    candidateProjectGroups,
    candidateRepos,
    args.groupId
  )
  const projectDisplayNameById = new Map(candidateRepos.map((repo) => [repo.id, repo.displayName]))
  return {
    ...targets,
    projectNames: targets.projectIds.map(
      (projectId) => projectDisplayNameById.get(projectId) ?? projectId
    )
  }
}
