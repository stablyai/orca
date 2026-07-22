import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { GitHubPrStartPoint, GlobalSettings } from '../../../shared/types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

type PrStartPointSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

export type GitHubPrStartPointInput = {
  repoId: string
  prNumber: number
  settings: PrStartPointSettings
  executionHostId?: ExecutionHostId
  headRefName?: string
  baseRefName?: string
  isCrossRepository?: boolean
}

export async function resolveGitHubPrStartPointForRepo({
  repoId,
  prNumber,
  settings,
  executionHostId,
  headRefName,
  baseRefName,
  isCrossRepository
}: GitHubPrStartPointInput): Promise<GitHubPrStartPoint> {
  const parsedHost = parseExecutionHostId(executionHostId)
  const target = parsedHost
    ? parsedHost.kind === 'runtime'
      ? { kind: 'environment' as const, environmentId: parsedHost.environmentId }
      : { kind: 'local' as const }
    : getActiveRuntimeTarget(settings)
  const prFields = {
    prNumber,
    ...(headRefName ? { headRefName } : {}),
    ...(baseRefName ? { baseRefName } : {}),
    ...(isCrossRepository !== undefined ? { isCrossRepository } : {})
  }
  const result =
    target.kind === 'local'
      ? await window.api.worktrees.resolvePrBase({ repoId, executionHostId, ...prFields })
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
