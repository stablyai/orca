import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'

const lookups = new WeakMap<readonly Repo[], ReturnType<typeof createProjectSetupRepoLookup>>()
export function buildProjectSetupRepoLookup(repos: readonly Repo[]) {
  let lookup = lookups.get(repos)
  if (!lookup) {
    lookup = createProjectSetupRepoLookup(repos)
    lookups.set(repos, lookup)
  }
  return lookup
}
function createProjectSetupRepoLookup(repos: readonly Repo[]) {
  const byId = new Map<string, Repo[]>()
  const byHost = new Map<string, Repo>()
  for (const repo of repos) {
    const candidates = byId.get(repo.id) ?? []
    candidates.push(repo)
    byId.set(repo.id, candidates)
    const key = `${getRepoExecutionHostId(repo)}\0${repo.id}`
    if (!byHost.has(key)) {
      byHost.set(key, repo)
    }
  }
  return {
    byId,
    resolve(setup: Pick<ProjectHostSetup, 'hostId' | 'repoId'>): Repo | null {
      const candidates = byId.get(setup.repoId) ?? []
      return (
        byHost.get(`${setup.hostId}\0${setup.repoId}`) ??
        (candidates.length === 1 && !candidates[0].executionHostId && !candidates[0].connectionId
          ? candidates[0]
          : null)
      )
    }
  }
}
