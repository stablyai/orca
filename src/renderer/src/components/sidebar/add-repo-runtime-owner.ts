import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

export type CapturedRuntimeOwner = string | null | undefined

export function worktreeRefreshOptions(
  owner: CapturedRuntimeOwner,
  sshConnectionId?: string | null
): {
  requireAuthoritative: true
  executionHostId?: ExecutionHostId
} {
  return {
    requireAuthoritative: true,
    ...(sshConnectionId
      ? { executionHostId: toSshExecutionHostId(sshConnectionId) }
      : owner !== undefined
        ? { executionHostId: owner ? toRuntimeExecutionHostId(owner) : LOCAL_EXECUTION_HOST_ID }
        : {})
  }
}
