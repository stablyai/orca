import type { Project } from '../../../shared/project-types'

const indexes = new WeakMap<
  readonly Project[],
  {
    byId: Map<string, Project>
    byRepo: Map<string, Project>
  }
>()

export function getIndexedLocalRuntimeProject(
  projects: readonly Project[],
  projectId: string,
  repoId: string
): Project | undefined {
  let index = indexes.get(projects)
  if (!index) {
    index = { byId: new Map(), byRepo: new Map() }
    for (const project of projects) {
      if (!index.byId.has(project.id)) {
        index.byId.set(project.id, project)
      }
      for (const id of [project.id, ...(project.sourceRepoIds ?? [])]) {
        if (!index.byRepo.has(id)) {
          index.byRepo.set(id, project)
        }
      }
    }
    indexes.set(projects, index)
  }
  return index.byId.get(projectId) ?? index.byRepo.get(repoId)
}
