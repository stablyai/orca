import type { Project } from '../../../shared/project-types'

type RuntimeProjectEntry = {
  project: Project
  position: number
}
const runtimeProjectIndex = new WeakMap<
  readonly Project[],
  {
    byId: Map<string, RuntimeProjectEntry>
    byRepo: Map<string, RuntimeProjectEntry>
  }
>()

export function getLocalRuntimeProject(
  projects: readonly Project[] | null | undefined,
  projectId: string,
  repoId: string,
  preferProject = false
) {
  if (!projects) {
    return undefined
  }
  let index = runtimeProjectIndex.get(projects)
  if (!index) {
    const next = {
      byId: new Map<string, RuntimeProjectEntry>(),
      byRepo: new Map<string, RuntimeProjectEntry>()
    }
    projects.forEach((project, position) => {
      if (!next.byId.has(project.id)) {
        next.byId.set(project.id, { project, position })
      }
      for (const id of [project.id, ...(project.sourceRepoIds ?? [])]) {
        if (!next.byRepo.has(id)) {
          next.byRepo.set(id, { project, position })
        }
      }
    })
    index = next
    runtimeProjectIndex.set(projects, index)
  }
  if (preferProject) {
    return index.byId.get(projectId)?.project
  }
  const byProject = index.byId.get(projectId)
  const byRepo = index.byRepo.get(repoId)
  return (!byProject || (byRepo && byRepo.position < byProject.position) ? byRepo : byProject)
    ?.project
}
