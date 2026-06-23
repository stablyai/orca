import type { GitHubRepositoryIdentity, Repo } from '../../../../shared/types'
import { githubAvatarIcon, type RepoIcon } from '../../../../shared/repo-icon'
import { callRuntimeRpc, type getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'

type RuntimeTarget = ReturnType<typeof getActiveRuntimeTarget>

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

export async function resolveRepositoryGitHubAvatarIcon(
  runtimeTarget: RuntimeTarget,
  repo: Repo
): Promise<RepoIcon | null> {
  const upstream =
    repo.upstream !== undefined
      ? repo.upstream
      : await resolveRepositoryUpstreamLive(runtimeTarget, repo).catch(() => null)
  if (upstream) {
    return githubAvatarIcon(upstream)
  }
  const slug =
    runtimeTarget.kind === 'environment'
      ? await callRuntimeRpc<{ owner: string; repo: string } | null>(
          runtimeTarget,
          'github.repoSlug',
          { repo: repo.id },
          { timeoutMs: 30_000 }
        )
      : await window.api.gh.repoSlug({ repoPath: repo.path, repoId: repo.id })
  return slug ? githubAvatarIcon(slug) : null
}
