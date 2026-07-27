import type { GitHubPRMergeMethod, PRInfo, Repo } from '../../../../shared/types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

type GitHubPRRepo = PRInfo['prRepo']

// Why: runtime-host projects mirror server paths into the desktop store, but
// desktop gh IPC only trusts local/SSH repo registrations.
function getGitHubActionTarget(repo: Repo): RuntimeClientTarget {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'runtime'
    ? { kind: 'environment', environmentId: host.environmentId }
    : { kind: 'local' }
}

export async function mergeGitHubHostedReview(args: {
  repo: Repo
  prNumber: number
  method: GitHubPRMergeMethod
  prRepo?: GitHubPRRepo | null
}): Promise<Awaited<ReturnType<typeof window.api.gh.mergePR>>> {
  const target = getGitHubActionTarget(args.repo)
  if (target.kind === 'environment') {
    return callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.mergePR>>>(
      target,
      'github.mergePR',
      {
        repo: args.repo.id,
        prNumber: args.prNumber,
        method: args.method,
        prRepo: args.prRepo ?? null
      },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gh.mergePR({
    repoPath: args.repo.path,
    repoId: args.repo.id,
    prNumber: args.prNumber,
    method: args.method,
    prRepo: args.prRepo ?? null
  })
}

export async function setGitHubHostedReviewAutoMerge(args: {
  repo: Repo
  prNumber: number
  enabled: boolean
  method?: GitHubPRMergeMethod
  prRepo?: GitHubPRRepo | null
}): Promise<Awaited<ReturnType<typeof window.api.gh.setPRAutoMerge>>> {
  const target = getGitHubActionTarget(args.repo)
  if (target.kind === 'environment') {
    return callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.setPRAutoMerge>>>(
      target,
      'github.setPRAutoMerge',
      {
        repo: args.repo.id,
        prNumber: args.prNumber,
        enabled: args.enabled,
        method: args.method,
        prRepo: args.prRepo ?? null
      },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gh.setPRAutoMerge({
    repoPath: args.repo.path,
    repoId: args.repo.id,
    prNumber: args.prNumber,
    enabled: args.enabled,
    method: args.method,
    prRepo: args.prRepo ?? null
  })
}

export async function updateGitHubHostedReviewState(args: {
  repo: Repo
  prNumber: number
  nextState: 'open' | 'closed'
  prRepo?: GitHubPRRepo | null
}): Promise<Awaited<ReturnType<typeof window.api.gh.updatePRState>>> {
  const target = getGitHubActionTarget(args.repo)
  if (target.kind === 'environment') {
    return callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.updatePRState>>>(
      target,
      'github.updatePRState',
      {
        repo: args.repo.id,
        prNumber: args.prNumber,
        prRepo: args.prRepo ?? null,
        updates: { state: args.nextState }
      },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gh.updatePRState({
    repoPath: args.repo.path,
    repoId: args.repo.id,
    prNumber: args.prNumber,
    prRepo: args.prRepo ?? null,
    updates: { state: args.nextState }
  })
}
