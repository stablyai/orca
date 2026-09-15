import type { AppState } from '@/store'
import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../shared/execution-host'

export function resolveRepoProject(
  state: Pick<AppState, 'projects' | 'projectHostSetups'>,
  repo?: Repo | null
) {
  if (!repo) {
    return undefined
  }
  const hostId = getRepoExecutionHostId(repo)
  const ids = new Set(
    state.projectHostSetups
      .filter((setup) => setup.hostId === hostId && setup.repoId === repo.id)
      .map((setup) => setup.projectId)
  )
  return ids.size === 1 ? state.projects.find((project) => ids.has(project.id)) : undefined
}
