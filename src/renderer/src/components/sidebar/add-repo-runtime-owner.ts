import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

export type CapturedRuntimeOwner = string | null | undefined

export function capturedAddRepoExecutionHostId(
  owner: CapturedRuntimeOwner,
  sshConnectionId?: string | null
): ExecutionHostId | undefined {
  return sshConnectionId
    ? toSshExecutionHostId(sshConnectionId)
    : owner !== undefined
      ? owner
        ? toRuntimeExecutionHostId(owner)
        : LOCAL_EXECUTION_HOST_ID
      : undefined
}

export function worktreeRefreshOptions(
  owner: CapturedRuntimeOwner,
  sshConnectionId?: string | null
): {
  requireAuthoritative: true
  executionHostId?: ExecutionHostId
} {
  const executionHostId = capturedAddRepoExecutionHostId(owner, sshConnectionId)
  return {
    requireAuthoritative: true,
    ...(executionHostId ? { executionHostId } : {})
  }
}
