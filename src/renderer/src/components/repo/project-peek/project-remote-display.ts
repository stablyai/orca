import type { Repo } from '../../../../../shared/repository/repo-types'
import { buildGitHubRepoUrl } from '../../../../../shared/github/repositories/links'
import { normalizeGitRemoteUrl } from '../../../../../shared/git/remotes/git-remote-identity'
import { getGitRemoteProviderIdentity } from '../../../../../shared/project/host-setup/project-host-setup-projection'
import { parseRemoteRepo } from '../../right-sidebar/source-control/review/remote-repo'

export type ProjectRemoteDisplay = {
  provider: 'github' | 'gitlab' | 'other'
  /** `owner/repo` for hosted remotes, else the normalized remote path. */
  slug: string
  /** Set for GitHub remotes, where the avatar can be offered as the project icon. */
  owner: string | null
  name: string | null
  /** Only off the provider's main host (GHES, self-hosted GitLab); shown on hover, never in place of the slug. */
  host: string | null
  webUrl: string | null
}

type RemoteRepo = Pick<Repo, 'gitRemoteIdentity' | 'upstream' | 'repoIcon'>

// Repos registered before remote identities were recorded still carry the slug on their GitHub avatar.
function githubIdentityFromAvatar(
  repo: RemoteRepo
): { owner: string; repo: string; host?: string } | null {
  if (repo.repoIcon?.type !== 'image' || repo.repoIcon.source !== 'github') {
    return null
  }
  const [owner, name, ...rest] = (repo.repoIcon.label ?? '').split('/')
  return owner && name && rest.length === 0 ? { owner, repo: name } : null
}

/** The checkout's own remote; a fork's parent is reported separately by the fork indicator. */
export function getProjectRemoteDisplay(repo: RemoteRepo): ProjectRemoteDisplay | null {
  const github = getGitRemoteProviderIdentity(repo) ?? githubIdentityFromAvatar(repo)
  if (github) {
    const host = github.host && github.host !== 'github.com' ? github.host : null
    return {
      provider: 'github',
      slug: `${github.owner}/${github.repo}`,
      owner: github.owner,
      name: github.repo,
      host,
      webUrl: buildGitHubRepoUrl(github)
    }
  }
  const remoteUrl = repo.gitRemoteIdentity?.remoteUrl
  const normalized = remoteUrl ? normalizeGitRemoteUrl(remoteUrl) : null
  if (!remoteUrl || !normalized) {
    return null
  }
  const slash = normalized.indexOf('/')
  const host = slash > 0 ? normalized.slice(0, slash) : normalized
  const slug = slash > 0 ? normalized.slice(slash + 1) : normalized
  const isGitLab = host === 'gitlab.com' || host.startsWith('gitlab.')
  return {
    provider: isGitLab ? 'gitlab' : 'other',
    slug,
    owner: null,
    name: null,
    host: host === 'gitlab.com' ? null : host,
    // The identity key drops the scheme and port that self-hosted http(s) forges need.
    webUrl: parseRemoteRepo(remoteUrl)?.webBaseUrl ?? `https://${normalized}`
  }
}
