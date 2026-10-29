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

// Renderer-only so older clients never receive a failure kind they would reject.
export type RepoScanFailureKind = WorktreeScanFailureKind | 'wsl-worktree-path'

export type RepoScanFailure = {
  kind: RepoScanFailureKind
  reason: string
  executionHostId: ExecutionHostId
  isLocalMac: boolean
}

export type LocalToolchainFailureKind = 'xcode-license' | 'developer-tools'

// Git for Windows aborts every command when core.worktree holds a WSL drive-mount path.
const WSL_WORKTREE_PATH_FAILURE = /Invalid path '\/mnt(?:\/[^']*)?'/

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
  const kind = WSL_WORKTREE_PATH_FAILURE.test(detected.unavailableReason)
    ? 'wsl-worktree-path'
    : (detected.failureKind ??
      (isLocalMac ? classifyWorktreeScanFailure(detected.unavailableReason) : 'unknown'))
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
  return blocked.length > 0
    ? { kind: blocked[0].kind, repos: blocked.map(({ repo }) => repo) }
    : null
}
