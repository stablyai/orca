import type { GitHubRepositoryIdentity, Repo } from '../../../../shared/types'
import { githubAvatarIcon, type RepoIcon } from '../../../../shared/repo-icon'
import { callRuntimeRpc, type getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'

type RuntimeTarget = ReturnType<typeof getActiveRuntimeTarget>
type ResolveRepositoryGitHubAvatarOptions = {
  forceLive?: boolean
}

export type RepositoryGitHubAvatarResolution = {
  repoIcon: RepoIcon | null
  upstream: GitHubRepositoryIdentity | null
}

export async function resolveRepositoryUpstreamLive(
  runtimeTarget: RuntimeTarget,
  repo: Repo
): Promise<GitHubRepositoryIdentity | null> {
  return runtimeTarget.kind === 'environment'
    ? await callRuntimeRpc<GitHubRepositoryIdentity | null>(
        runtimeTarget,
        'github.repoUpstream',
        { repo: repo.id },
        { timeoutMs: 30_000 }
      )
    : await window.api.gh.repoUpstream({ repoPath: repo.path, repoId: repo.id })
}

async function resolveRepositorySlugLive(
  runtimeTarget: RuntimeTarget,
  repo: Repo
): Promise<GitHubRepositoryIdentity | null> {
  return runtimeTarget.kind === 'environment'
    ? await callRuntimeRpc<GitHubRepositoryIdentity | null>(
        runtimeTarget,
        'github.repoSlug',
        { repo: repo.id },
        { timeoutMs: 30_000 }
      )
    : await window.api.gh.repoSlug({ repoPath: repo.path, repoId: repo.id })
}

export async function resolveRepositoryGitHubAvatar(
  runtimeTarget: RuntimeTarget,
  repo: Repo,
  options: ResolveRepositoryGitHubAvatarOptions = {}
): Promise<RepositoryGitHubAvatarResolution> {
  const upstream =
    !options.forceLive && repo.upstream !== undefined
      ? repo.upstream
      : await resolveRepositoryUpstreamLive(runtimeTarget, repo).catch(() => null)
  if (upstream) {
    return { repoIcon: githubAvatarIcon(upstream), upstream }
  }
  const slug = await resolveRepositorySlugLive(runtimeTarget, repo)
  return { repoIcon: slug ? githubAvatarIcon(slug) : null, upstream: null }
}

export async function resolveRepositoryGitHubAvatarIcon(
  runtimeTarget: RuntimeTarget,
  repo: Repo,
  options: ResolveRepositoryGitHubAvatarOptions = {}
): Promise<RepoIcon | null> {
  return (await resolveRepositoryGitHubAvatar(runtimeTarget, repo, options)).repoIcon
}

function sameRepositoryIdentity(
  a: GitHubRepositoryIdentity | null | undefined,
  b: GitHubRepositoryIdentity | null | undefined
): boolean {
  if (!a || !b) {
    return a === b
  }
  return a.owner === b.owner && a.repo === b.repo
}

function sameRepoIcon(a: RepoIcon | null | undefined, b: RepoIcon | null | undefined): boolean {
  if (!a || !b) {
    return a === b
  }
  if (a.type !== b.type) {
    return false
  }
  if (a.type === 'image' && b.type === 'image') {
    return a.src === b.src && a.source === b.source && a.label === b.label
  }
  if (a.type === 'emoji' && b.type === 'emoji') {
    return a.emoji === b.emoji
  }
  return a.type === 'lucide' && b.type === 'lucide' && a.name === b.name
}

export function buildRepositoryGitHubAvatarUpdate(
  repo: Repo,
  resolution: RepositoryGitHubAvatarResolution,
  options: { clearMissingIcon?: boolean } = {}
): Partial<Repo> | null {
  const updates: Partial<Repo> = {}

  if (!sameRepositoryIdentity(repo.upstream, resolution.upstream)) {
    updates.upstream = resolution.upstream
  }

  if (
    (resolution.repoIcon || options.clearMissingIcon) &&
    !sameRepoIcon(repo.repoIcon, resolution.repoIcon)
  ) {
    updates.repoIcon = resolution.repoIcon
  }

  return Object.keys(updates).length > 0 ? updates : null
}
