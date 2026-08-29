import type { Repo } from '../../../../shared/repo-types'

// Matches a GitHub `owner/repo` against projects already added to Orca, via the
// probed remote identity (canonicalKey `github.com/owner/repo`) or the fork's
// recorded upstream identity.
export function findAddedGitHubRepo(repos: readonly Repo[], fullName: string): Repo | null {
  const target = fullName.trim().toLowerCase()
  if (!target) {
    return null
  }
  for (const repo of repos) {
    const key = repo.gitRemoteIdentity?.canonicalKey
    if (key && key.toLowerCase() === `github.com/${target}`) {
      return repo
    }
    const upstream = repo.upstream
    if (upstream && `${upstream.owner}/${upstream.repo}`.toLowerCase() === target) {
      return repo
    }
  }
  return null
}
