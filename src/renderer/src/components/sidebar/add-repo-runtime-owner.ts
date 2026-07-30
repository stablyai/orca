import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

export type CapturedRuntimeOwner = string | null | undefined

export function worktreeRefreshOptions(owner: CapturedRuntimeOwner): {
  requireAuthoritative: true
  executionHostId?: ExecutionHostId
} {
  return {
    requireAuthoritative: true,
    ...(owner !== undefined
      ? { executionHostId: owner ? toRuntimeExecutionHostId(owner) : LOCAL_EXECUTION_HOST_ID }
      : {})
  }
}
