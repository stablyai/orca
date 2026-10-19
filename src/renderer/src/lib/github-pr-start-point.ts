import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { GitHubPrStartPoint } from '../../../shared/worktree/types'

export type GitHubPrStartPointInput = {
  repoId: string
  prNumber: number
  /** The repo owner's transport; `null` (no routable owner) is refused. */
  target: RuntimeClientTarget | null
  headRefName?: string
  baseRefName?: string
  isCrossRepository?: boolean
}

export async function resolveGitHubPrStartPointForRepo({
  repoId,
  prNumber,
  target,
  headRefName,
  baseRefName,
  isCrossRepository
}: GitHubPrStartPointInput): Promise<GitHubPrStartPoint> {
  if (!target) {
    throw new Error('The project host is unresolved. Refresh the project and retry.')
  }
  const prFields = {
    prNumber,
    ...(headRefName ? { headRefName } : {}),
    ...(baseRefName ? { baseRefName } : {}),
    ...(isCrossRepository !== undefined ? { isCrossRepository } : {})
  }
  const result =
    target.kind === 'local'
      ? await window.api.worktrees.resolvePrBase({ repoId, ...prFields })
      : await callRuntimeRpc<GitHubPrStartPoint | { error: string }>(
          target,
          'worktree.resolvePrBase',
          { repo: repoId, ...prFields },
          { timeoutMs: 30_000 }
        )
  if ('error' in result) {
    throw new Error(result.error)
  }
  return result
}
