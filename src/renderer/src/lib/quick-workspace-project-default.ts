import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { TuiAgent } from '../../../shared/tui-agent'

/** The selected target project owns the workspace; a missing or inherited value uses global. */
export function projectWorkspaceDefault(
  projects: readonly Pick<Project, 'id' | 'defaultTuiAgent'>[],
  projectId: string | null | undefined,
  globalDefault: TuiAgent | 'blank' | null | undefined
): TuiAgent | 'blank' | null | undefined {
  return projects.find((project) => project.id === projectId)?.defaultTuiAgent ?? globalDefault
}

/** A folder group has a default only when all of its source repos have one project owner. */
export function folderGroupDefaultTarget(
  repoIds: readonly string[],
  projects: readonly Pick<Project, 'id' | 'sourceRepoIds'>[],
  setups: readonly Pick<ProjectHostSetup, 'repoId' | 'projectId' | 'hostId'>[],
  hostId: string | null | undefined
): { repoId: string; projectId: string } | null {
  if (!repoIds.length || !hostId) {
    return null
  }
  let projectId: string | undefined
  for (const repoId of repoIds) {
    const sourceOwners = projects.filter((project) => project.sourceRepoIds.includes(repoId))
    const ownerIds = new Set(
      setups
        .filter((setup) => setup.repoId === repoId && setup.hostId === hostId)
        .map((setup) => setup.projectId)
    )
    if (ownerIds.size > 1) {
      return null
    }
    const owner =
      ownerIds.values().next().value ?? (sourceOwners.length === 1 ? sourceOwners[0].id : undefined)
    if (!owner || (projectId && owner !== projectId)) {
      return null
    }
    projectId = owner
  }
  return projectId ? { repoId: repoIds[0], projectId } : null
}
