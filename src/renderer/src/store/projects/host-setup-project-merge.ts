import type { Project } from '../../../../shared/project-types'
import { mergeProjectCompatibilityProject } from '../../../../shared/project-compatibility-merge'

/**
 * Folds the project row a host returned from "set up existing folder" into the known projects.
 * A remote host (an Orca Cloud sandbox, a runtime server) names the project after its own checkout
 * folder, e.g. "project", so an existing project keeps its name and the repos it already owns.
 */
export function upsertHostSetupProject(
  projects: readonly Project[],
  project: Project,
  remoteHost: boolean
): Project[] {
  const existing = projects.find((entry) => entry.id === project.id)
  if (!existing) {
    return [...projects, project]
  }
  const merged = mergeProjectCompatibilityProject(existing, project)
  const next = remoteHost ? { ...merged, displayName: existing.displayName } : merged
  return projects.map((entry) => (entry.id === project.id ? next : entry))
}
