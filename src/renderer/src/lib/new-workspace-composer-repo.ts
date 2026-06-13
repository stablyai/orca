import { isGitRepoKind } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/types'

export function getComposerEligibleRepos(repos: readonly Repo[]): Repo[] {
  return repos.filter((repo) => Boolean(repo.path))
}

export function resolveComposerRepoId({
  eligibleRepos,
  draftRepoId,
  initialRepoId,
  activeRepoId
}: {
  eligibleRepos: readonly Repo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
}): string {
  const resolvedRepo =
    (draftRepoId && eligibleRepos.find((repo) => repo.id === draftRepoId)) ||
    (initialRepoId && eligibleRepos.find((repo) => repo.id === initialRepoId)) ||
    (activeRepoId && eligibleRepos.find((repo) => repo.id === activeRepoId)) ||
    eligibleRepos[0]

  return resolvedRepo?.id ?? ''
}

export function resolveComposerGitRepoId(args: {
  eligibleRepos: readonly Repo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
}): string | null {
  const repoId = resolveComposerRepoId(args)
  const repo = repoId ? args.eligibleRepos.find((entry) => entry.id === repoId) : null
  return repo && isGitRepoKind(repo) ? repo.id : null
}
