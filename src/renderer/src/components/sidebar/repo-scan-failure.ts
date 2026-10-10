import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  classifyWorktreeScanFailure,
  type WorktreeScanFailureKind
} from '../../../../shared/worktree-scan-failure'

export type RepoScanFailure = {
  kind: WorktreeScanFailureKind
  reason: string
  executionHostId: ExecutionHostId
  isLocalMac: boolean
}

export type LocalToolchainFailureKind = 'xcode-license' | 'developer-tools'

export function resolveRepoScanFailure(
  repo: Repo,
  detected: DetectedWorktreeListResult | undefined
): RepoScanFailure | null {
  if (!detected || detected.authoritative || !detected.unavailableReason) {
    return null
  }
  const executionHostId = getRepoExecutionHostId(repo)
  const isLocalMac =
    executionHostId === LOCAL_EXECUTION_HOST_ID &&
    !repo.connectionId &&
    navigator.userAgent.includes('Mac')
  const kind =
    detected.failureKind ??
    (isLocalMac ? classifyWorktreeScanFailure(detected.unavailableReason) : 'unknown')
  return { kind, reason: detected.unavailableReason, executionHostId, isLocalMac }
}

/** Failures that break Git for every local repo at once; the sidebar banner owns these. */
export function isLocalToolchainFailure(
  failure: RepoScanFailure
): failure is RepoScanFailure & { kind: LocalToolchainFailureKind } {
  return (
    failure.isLocalMac && (failure.kind === 'xcode-license' || failure.kind === 'developer-tools')
  )
}

export function findLocalToolchainBlock(
  repos: readonly Repo[],
  detectedByRepo: Record<string, DetectedWorktreeListResult | undefined>
): { kind: LocalToolchainFailureKind; repos: Repo[] } | null {
  const blocked = repos.flatMap((repo) => {
    const failure = resolveRepoScanFailure(repo, detectedByRepo[repo.id])
    return failure && isLocalToolchainFailure(failure) ? [{ repo, kind: failure.kind }] : []
  })
  // Why: every local repo shares one Git binary, so all blocked repos report the same kind.
  return blocked.length > 0
    ? { kind: blocked[0].kind, repos: blocked.map(({ repo }) => repo) }
    : null
}
