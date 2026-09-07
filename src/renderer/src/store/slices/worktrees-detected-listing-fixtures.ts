import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../../shared/ssh-types'
import type {
  HostQualifiedDetectedWorktreeResult,
  ListDetectedWorktreesArgs
} from '../../../../shared/detected-worktree-provider-contract'

export function makeDetectedResult(
  repoId: string,
  worktrees: Worktree[],
  overrides: Partial<DetectedWorktreeListResult> = {}
): DetectedWorktreeListResult {
  return {
    repoId,
    authoritative: true,
    source: 'git',
    ...overrides,
    worktrees: worktrees.map((worktree) => ({
      ...worktree,
      ownership: 'orca-managed' as const,
      selectedCheckout: false,
      visible: true
    }))
  }
}

export const TEST_SSH_AUTHORITY: DirectSshAuthority = {
  targetId: 'ssh-1',
  providerEpoch: 'provider-ssh-1' as SshProviderEpoch,
  connectionGeneration: 1
}

export function qualifyDetectedResult(
  args: ListDetectedWorktreesArgs,
  result: DetectedWorktreeListResult
): HostQualifiedDetectedWorktreeResult {
  return {
    status: result.authoritative ? 'complete' : 'non-authoritative',
    providerRequestId: args.providerRequestId,
    repoId: args.repoId,
    authority:
      args.executionHostId === LOCAL_EXECUTION_HOST_ID
        ? { kind: 'local', executionHostId: LOCAL_EXECUTION_HOST_ID }
        : {
            kind: 'direct-ssh',
            executionHostId: args.executionHostId,
            ...args.expectedAuthority
          },
    result
  }
}
