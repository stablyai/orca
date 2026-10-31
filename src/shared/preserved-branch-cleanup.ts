import type { ExecutionHostId } from './execution-host'

export type PreservedBranchCleanup = {
  worktreeId: string
  branchName: string
  expectedHead?: string
  hostId?: ExecutionHostId
  runtimeEnvironmentId?: string
}

export function preservedBranchCleanupScopeKey(
  cleanup: Pick<PreservedBranchCleanup, 'worktreeId' | 'hostId' | 'runtimeEnvironmentId'>
): string {
  return [cleanup.hostId ?? '', cleanup.runtimeEnvironmentId ?? '', cleanup.worktreeId].join('\0')
}

export function preservedBranchCleanupKey(cleanup: PreservedBranchCleanup): string {
  return [
    preservedBranchCleanupScopeKey(cleanup),
    cleanup.branchName,
    cleanup.expectedHead ?? ''
  ].join('\0')
}
