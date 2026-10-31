import type { Repo } from '../../../../shared/repo-types'
import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import { toAiVaultProjectKey } from '../../../../shared/ai-vault-project-key'

export function buildProjectLabelByKey(
  repos: readonly Repo[],
  projection: ProjectHostSetupProjection
): Map<string, string> {
  const labels = new Map<string, string>()
  const projectLabelById = new Map(
    projection.projects.map((project) => [project.id, project.displayName])
  )

  for (const project of projection.projects) {
    const key = toAiVaultProjectKey(project.id, project.sourceRepoIds[0])
    if (key && !key.startsWith('repo:')) {
      labels.set(key, project.displayName)
    }
  }

  for (const repo of repos) {
    labels.set(`repo:${repo.id}`, repo.displayName)
  }

  for (const setup of projection.setups) {
    const key = toAiVaultProjectKey(setup.projectId, setup.repoId)
    if (key && !labels.has(key)) {
      labels.set(key, projectLabelById.get(setup.projectId) ?? setup.displayName)
    }
  }

  return labels
}
