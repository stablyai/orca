import type { GitHubPRMergeMethod, PRInfo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import {
  GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY,
  GITHUB_MARK_PR_READY_UPDATE_REQUIRED_MESSAGE
} from '../../../../shared/protocol-version'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

type GitHubPRRepo = PRInfo['prRepo']

// Runtime paths mirrored into desktop state are not trusted local/SSH registrations; route through the runtime owner.
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
      // GitHub stack merges can take several asynchronous minutes.
      { timeoutMs: 4 * 60_000 }
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

export async function markGitHubHostedReviewReadyForReview(args: {
  repo: Repo
  prNumber: number
  prRepo?: GitHubPRRepo | null
}): Promise<Awaited<ReturnType<typeof window.api.gh.markPRReadyForReview>>> {
  const target = getGitHubActionTarget(args.repo)
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY,
      GITHUB_MARK_PR_READY_UPDATE_REQUIRED_MESSAGE
    )
    return callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.markPRReadyForReview>>>(
      target,
      'github.markPRReadyForReview',
      {
        repo: args.repo.id,
        prNumber: args.prNumber,
        prRepo: args.prRepo ?? null
      },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gh.markPRReadyForReview({
    repoPath: args.repo.path,
    repoId: args.repo.id,
    prNumber: args.prNumber,
    prRepo: args.prRepo ?? null
  })
}
