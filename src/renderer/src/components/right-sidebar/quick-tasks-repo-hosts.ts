import { isGitHubBackedRepo } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/repo-types'
import { parseRemoteRepo } from './source-control/review/remote-repo'

/** `unknown` covers remote-less repos and self-hosted forges whose host name gives no hint. */
export type QuickTasksRepoHost = 'github' | 'gitlab' | 'other' | 'unknown'

export function getQuickTasksRepoHost(
  repo: Pick<Repo, 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
): QuickTasksRepoHost {
  if (isGitHubBackedRepo(repo)) {
    return 'github'
  }
  const remote = parseRemoteRepo(repo.gitRemoteIdentity?.remoteUrl ?? '')
  if (!remote) {
    return 'unknown'
  }
  if (remote.provider === 'github' || remote.provider === 'gitlab') {
    return remote.provider
  }
  if (remote.provider) {
    return 'other'
  }
  // Why: self-hosted GitLab (e.g. gitlab.example.org) is not on parseRemoteRepo's public-host list.
  let hostname = ''
  try {
    hostname = new URL(remote.webBaseUrl).hostname
  } catch {
    return 'unknown'
  }
  return hostname.includes('gitlab') ? 'gitlab' : 'unknown'
}

/** Repos each forge should query: detected hosts go to their own forge, undetected ones to both. */
export function splitQuickTasksReposByHost<R extends Repo>(
  repos: readonly R[]
): { github: R[]; gitlab: R[] } {
  const github: R[] = []
  const gitlab: R[] = []
  for (const repo of repos) {
    const host = getQuickTasksRepoHost(repo)
    if (host === 'github' || host === 'unknown') {
      github.push(repo)
    }
    if (host === 'gitlab' || host === 'unknown') {
      gitlab.push(repo)
    }
  }
  return { github, gitlab }
}
