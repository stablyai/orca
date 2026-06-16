import type { DockerContainerSummary } from '../../../../shared/docker-types'

export type DockerServiceGroup = { service: string; containers: DockerContainerSummary[] }
export type DockerComposeProjectGroup = { project: string; services: DockerServiceGroup[] }
export type DockerContainerGroups = {
  composeProjects: DockerComposeProjectGroup[]
  standalone: DockerContainerSummary[]
}

function nameOf(c: DockerContainerSummary): string {
  return c.names[0] ?? c.id
}

/**
 * Group containers into compose project → service → container, plus a flat
 * standalone list (no compose project). Deterministically sorted so the tree is stable.
 * Project containers lacking a service land in a service group named '' (rendered without a service node).
 */
export function buildDockerContainerGroups(
  containers: DockerContainerSummary[]
): DockerContainerGroups {
  const standalone: DockerContainerSummary[] = []
  const projectMap = new Map<string, Map<string, DockerContainerSummary[]>>()

  for (const container of containers) {
    const project = container.composeProject
    if (!project) {
      standalone.push(container)
      continue
    }
    const service = container.composeService ?? ''
    let services = projectMap.get(project)
    if (!services) {
      services = new Map()
      projectMap.set(project, services)
    }
    const bucket = services.get(service)
    if (bucket) {
      bucket.push(container)
    } else {
      services.set(service, [container])
    }
  }

  const composeProjects: DockerComposeProjectGroup[] = [...projectMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([project, services]) => ({
      project,
      services: [...services.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([service, list]) => ({
          service,
          containers: [...list].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
        }))
    }))

  standalone.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
  return { composeProjects, standalone }
}
