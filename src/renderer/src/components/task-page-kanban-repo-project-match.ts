import {
  parseRemoteRepo,
  type RemoteRepoRef
} from './right-sidebar/source-control/review/remote-repo'

export type KanbanRepoCandidate = {
  id: string
  gitRemoteIdentity?: { remoteUrl: string } | null
}

export type KanbanRepoMatchResult =
  | { kind: 'unique'; repo: KanbanRepoCandidate }
  | { kind: 'none' }
  | { kind: 'multiple' }

// Why: GitHub repository paths are case-insensitive; other hosts are not.
function repositoryPathForCompare(ref: RemoteRepoRef): string {
  return ref.provider === 'github' ? ref.path.toLowerCase() : ref.path
}

function sameRepository(a: RemoteRepoRef, b: RemoteRepoRef): boolean {
  return a.provider === b.provider && repositoryPathForCompare(a) === repositoryPathForCompare(b)
}

/**
 * Match the repository URLs recorded on a Kanban card against the local Orca
 * repos. Exactly one unambiguous repo match preselects it; no match, several
 * card repositories, or several local repos on the same URL leave the project
 * selection open. Never clones anything — this is pure URL normalization via
 * `parseRemoteRepo`.
 */
export function matchKanbanTaskRepository({
  repositoryUrls,
  repos
}: {
  repositoryUrls: readonly string[]
  repos: readonly KanbanRepoCandidate[]
}): KanbanRepoMatchResult {
  const cardRepos: RemoteRepoRef[] = []
  for (const url of repositoryUrls) {
    const ref = parseRemoteRepo(url)
    if (!ref || cardRepos.some((existing) => sameRepository(existing, ref))) {
      continue
    }
    cardRepos.push(ref)
  }
  if (cardRepos.length === 0) {
    return { kind: 'none' }
  }
  if (cardRepos.length > 1) {
    return { kind: 'multiple' }
  }
  const cardRepo = cardRepos[0]
  const matches = repos.filter((repo) => {
    const repoRef = parseRemoteRepo(repo.gitRemoteIdentity?.remoteUrl ?? '')
    return repoRef !== null && sameRepository(cardRepo, repoRef)
  })
  if (matches.length === 0) {
    return { kind: 'none' }
  }
  if (matches.length > 1) {
    return { kind: 'multiple' }
  }
  return { kind: 'unique', repo: matches[0] }
}
