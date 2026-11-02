import { callRuntimeRpc } from '../../../../runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { isPositiveHostedReviewNumber } from '../../../../../../shared/hosted-review'
import type {
  GitHubPrStartPoint,
  GitPushTarget,
  Worktree
} from '../../../../../../shared/worktree/types'

export const hostedReviewPushTargetLookupsInFlight = new Set<string>()

export async function resolveGitHubReviewPushTarget(
  target: RuntimeClientTarget,
  repoId: string,
  prNumber: number
): Promise<GitPushTarget | undefined> {
  try {
    const result =
      target.kind === 'local'
        ? await window.api.worktrees.resolvePrBase({ repoId, prNumber })
        : await callRuntimeRpc<GitHubPrStartPoint | { error: string }>(
            target,
            'worktree.resolvePrBase',
            { repo: repoId, prNumber },
            { timeoutMs: 30_000 }
          )
    if ('error' in result) {
      console.warn(`Failed to resolve push target for PR #${prNumber}: ${result.error}`)
      return undefined
    }
    return result.pushTarget
  } catch (error) {
    console.warn(
      `Failed to resolve push target for PR #${prNumber}:`,
      error instanceof Error ? error.message : error
    )
    return undefined
  }
}

export async function resolveGitLabReviewPushTarget(
  target: RuntimeClientTarget,
  repoId: string,
  mrIid: number
): Promise<GitPushTarget | undefined> {
  try {
    const result =
      target.kind === 'local'
        ? await window.api.worktrees.resolveMrBase({ repoId, mrIid })
        : await callRuntimeRpc<
            | { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget }
            | {
                error: string
              }
          >(target, 'worktree.resolveMrBase', { repo: repoId, mrIid }, { timeoutMs: 30_000 })
    if ('error' in result) {
      console.warn(`Failed to resolve push target for MR !${mrIid}: ${result.error}`)
      return undefined
    }
    return result.pushTarget
  } catch (error) {
    console.warn(
      `Failed to resolve push target for MR !${mrIid}:`,
      error instanceof Error ? error.message : error
    )
    return undefined
  }
}

export function getHostedReviewPushTargetLookup(worktree: Worktree): {
  key: string
  resolve: (target: RuntimeClientTarget) => Promise<GitPushTarget | undefined>
} | null {
  const hostScope = worktree.hostId ?? ''
  if (isPositiveHostedReviewNumber(worktree.linkedPR)) {
    const prNumber = worktree.linkedPR
    return {
      key: `${worktree.id}:${hostScope}:github:${prNumber}`,
      resolve: (target) => resolveGitHubReviewPushTarget(target, worktree.repoId, prNumber)
    }
  }
  if (isPositiveHostedReviewNumber(worktree.linkedGitLabMR)) {
    const mrIid = worktree.linkedGitLabMR
    return {
      key: `${worktree.id}:${hostScope}:gitlab:${mrIid}`,
      resolve: (target) => resolveGitLabReviewPushTarget(target, worktree.repoId, mrIid)
    }
  }
  return null
}
