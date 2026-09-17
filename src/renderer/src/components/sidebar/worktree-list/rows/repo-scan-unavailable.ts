import type { Repo } from '../../../../../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { isWslUncPath } from '../../../../../../shared/wsl-paths'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import {
  classifyWorktreeScanFailure,
  type WorktreeScanFailureKind
} from '../../../../../../shared/worktree-scan-failure'

export type UnavailableRepoScanTarget = {
  repoId: string
  executionHostId: ExecutionHostId
  failureKind: WorktreeScanFailureKind
}

// Why: retry-all fans out per repo so each scan runs on the host that owns it.
export function selectUnavailableRepoScanTargets(args: {
  repos: readonly Repo[]
  detectedByRepo: Record<string, DetectedWorktreeListResult | undefined>
}): UnavailableRepoScanTarget[] {
  return args.repos.flatMap((repo) => {
    const detected = args.detectedByRepo[repo.id]
    if (!detected || detected.authoritative || !detected.unavailableReason) {
      return []
    }
    return [
      {
        repoId: repo.id,
        executionHostId: getRepoExecutionHostId(repo),
        failureKind: classifyWorktreeScanFailure(detected.unavailableReason)
      }
    ]
  })
}

/**
 * Peers that the same fix just repaired. An Xcode license or a missing toolchain is a property of
 * the machine, not of one checkout, so a scan that succeeds there settles every repo failing the
 * same way on that host. An unclassified failure earns no fan-out: it can be repo-local.
 */
export function selectHostWideScanRetryTargets(args: {
  targets: readonly UnavailableRepoScanTarget[]
  resolvedRepoId: string
  executionHostId: ExecutionHostId
  failureKind: WorktreeScanFailureKind
}): UnavailableRepoScanTarget[] {
  if (args.failureKind === 'unknown') {
    return []
  }
  return args.targets.filter(
    (target) =>
      target.repoId !== args.resolvedRepoId &&
      target.executionHostId === args.executionHostId &&
      target.failureKind === args.failureKind
  )
}

export async function retryUnavailableRepoScans(
  targets: readonly UnavailableRepoScanTarget[],
  fetchWorktrees: (
    repoId: string,
    options?: { executionHostId: ExecutionHostId; requireAuthoritative?: boolean }
  ) => Promise<unknown>
): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(
    targets.map((target) =>
      fetchWorktrees(target.repoId, {
        executionHostId: target.executionHostId,
        requireAuthoritative: true
      })
    )
  )
}

// Why: the fix is a macOS command, so it needs this machine to be the Mac that runs the scan —
// a remote/runtime owner, a WSL checkout, or a non-darwin renderer all make it nonsense.
export function canOpenScanFixTerminal(
  repo: Pick<Repo, 'connectionId' | 'executionHostId' | 'path'>,
  platform: NodeJS.Platform = getRendererAppPlatform()
): boolean {
  if (platform !== 'darwin' || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    return false
  }
  return !isWslUncPath(repo.path ?? '')
}
