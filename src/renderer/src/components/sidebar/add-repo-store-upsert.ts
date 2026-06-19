import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/types'
import { useAppStore } from '@/store'

export function upsertAddedRepoWithProjectHostSetup(repo: Repo): void {
  const state = useAppStore.getState()
  const repos = state.repos.some((entry) => entry.id === repo.id)
    ? state.repos.map((entry) => (entry.id === repo.id ? repo : entry))
    : [...state.repos, repo]
  const projection = projectHostSetupProjectionFromRepos(repos)

  // Why: these Add Project flows call IPC directly, bypassing the repo slice
  // action that normally keeps the project-first compatibility model synced.
  useAppStore.setState({
    repos,
    projects: projection.projects,
    projectHostSetups: projection.setups
  })
}
