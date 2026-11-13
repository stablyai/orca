import { isDefaultGitHubHost } from '../repositories/repository-identity-key'

export type GitHubProjectIdentity = {
  owner: string
  ownerType: 'organization' | 'user'
  number: number
  host?: string
}

/** Stable settings/cache identity. Default-host keys intentionally retain the
 * legacy shape so existing github.com project preferences survive upgrades. */
export function githubProjectIdentityKey(project: GitHubProjectIdentity): string {
  const projectKey = `${project.ownerType}:${project.owner.toLowerCase()}:${project.number}`
  const host = project.host?.trim().toLowerCase()
  return host && !isDefaultGitHubHost(host) ? `${host}:${projectKey}` : projectKey
}

/** Project API calls must pin github.com too; otherwise process GH_HOST can
 * redirect a host-less persisted project to an Enterprise server. */
export function githubProjectHost(host?: string | null): string {
  const trimmed = host?.trim()
  return trimmed || 'github.com'
}

/** Settings rows carry only identity fields: the host's settings schema rejects extra keys
 * such as a picker row's title, and hosts before 2026-07-21 reject `host`, so github.com stays implicit. */
export function toGitHubProjectIdentity(project: GitHubProjectIdentity): GitHubProjectIdentity {
  const host = project.host?.trim()
  return {
    owner: project.owner,
    ownerType: project.ownerType,
    number: project.number,
    ...(host && !isDefaultGitHubHost(host) ? { host } : {})
  }
}
